import { supabase } from '@/lib/supabase';
import { offlineDB, type PendingExpression } from '@/lib/db';
import { normalizeFr } from '@/lib/normalizeFr';
import { parsePasteText } from '@/lib/pasteParser';
import { triggerAutoAnalysis, type AnalyzableRow } from '@/features/ai-batch/autoAnalyze';

export interface AddExpressionInput {
  userId: string;
  expressionFr: string;
  sourceType: string;
  originalContext?: string | null;
}

export interface AddExpressionResult {
  stored: 'online' | 'offline';
  /** How many rows this input turned into (pasteParser may split one input into several). */
  savedCount: number;
  possibleDuplicate: { id: string; expression_fr: string } | null;
}

// "수업"/"학교"/"école" (등) 이 출처 칸에 들어가면 source_type을 school로
// 맞춰준다 -- 자유 텍스트 출처칸과 표현장 필터용 enum을 이어주는 용도.
const SCHOOL_CONTEXT_KEYWORDS = ['수업', '학교', 'école', 'ecole', 'school', 'class'];

export function inferSourceTypeFromContext(context: string | null | undefined, fallback: string): string {
  if (!context) return fallback;
  const lower = context.toLowerCase();
  return SCHOOL_CONTEXT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase())) ? 'school' : fallback;
}

async function findPossibleDuplicate(userId: string, expressionFr: string) {
  const normalized = normalizeFr(expressionFr);
  const { data } = await supabase
    .from('expressions')
    .select('id, expression_fr')
    .eq('user_id', userId)
    .eq('expression_fr_normalized', normalized)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

interface RowToSave {
  expressionFr: string;
  meaningKo: string | null;
  tags: string[];
}

/**
 * Turns one textarea submission into 1+ rows: if the text contains the
 * same bullet/dash-list shape pasteParser already understands (single line
 * with a "fr — ko" split, or multiple lines), it gets split the same way
 * the "붙여넣기 저장" screen would. Plain single-expression input (no
 * separator found) still saves as exactly one row, unchanged.
 */
export function splitInputIntoRows(text: string): RowToSave[] {
  const { rows } = parsePasteText(text);
  const usable = rows.filter((r) => r.status !== 'needs_review');
  if (usable.length === 0) {
    // Nothing parsed (e.g. a bare Korean-only line) -- fall back to saving
    // the raw text as-is rather than silently dropping it.
    return [{ expressionFr: text.trim(), meaningKo: null, tags: [] }];
  }
  return usable.map((r) => ({ expressionFr: r.expressionFr, meaningKo: r.meaningKo || null, tags: r.tags }));
}

/**
 * Saves the raw expression text immediately (spec requirement: never make
 * the user wait for AI analysis). Falls back to an IndexedDB queue -- not an
 * error toast -- whenever we're offline or the network write itself fails,
 * so the user's input is never lost mid-class.
 */
export async function addExpression(input: AddExpressionInput): Promise<AddExpressionResult> {
  const rows = splitInputIntoRows(input.expressionFr);
  const sourceType = inferSourceTypeFromContext(input.originalContext, input.sourceType);

  let possibleDuplicate: { id: string; expression_fr: string } | null = null;
  if (navigator.onLine && rows.length === 1) {
    try {
      possibleDuplicate = await findPossibleDuplicate(input.userId, rows[0].expressionFr);
    } catch {
      // Duplicate check is best-effort only; never block saving on it.
    }
  }

  const createdAt = new Date().toISOString();
  const queueOffline = async (row: RowToSave, lastError: string | null) => {
    await offlineDB.pendingExpressions.put({
      clientId: crypto.randomUUID(),
      userId: input.userId,
      expressionFr: row.expressionFr,
      meaningKo: row.meaningKo,
      tags: row.tags,
      sourceType,
      originalContext: input.originalContext ?? null,
      createdAt,
      syncStatus: 'pending',
      lastError,
    });
  };

  if (!navigator.onLine) {
    for (const row of rows) await queueOffline(row, null);
    return { stored: 'offline', savedCount: rows.length, possibleDuplicate };
  }

  let onlineCount = 0;
  const needsAnalysis: AnalyzableRow[] = [];
  for (const row of rows) {
    const clientId = crypto.randomUUID();
    const { data, error } = await supabase
      .from('expressions')
      .upsert(
        {
          user_id: input.userId,
          client_id: clientId,
          expression_fr: row.expressionFr,
          meaning_ko: row.meaningKo,
          tags: row.tags,
          source_type: sourceType,
          original_context: input.originalContext ?? null,
        },
        { onConflict: 'user_id,client_id' }
      )
      .select('id')
      .single();

    if (error || !data) {
      await queueOffline(row, error?.message ?? 'unknown error');
      continue;
    }

    onlineCount++;
    await enqueueForReview(input.userId, data.id);
    needsAnalysis.push({ expressionId: data.id, expressionFr: row.expressionFr, needsMeaning: !row.meaningKo });
  }

  // One batched call (via analyze-batch) instead of one Edge Function
  // invocation per row -- same consolidation as the paste-save flow.
  void triggerAutoAnalysis(needsAnalysis).catch(() => {});

  return {
    stored: onlineCount === rows.length ? 'online' : onlineCount === 0 ? 'offline' : 'online',
    savedCount: rows.length,
    possibleDuplicate,
  };
}

/**
 * Spec requirement: saving an expression immediately adds it to the review
 * queue (due_at = now), independent of whether/when AI analysis finishes.
 * Idempotent via the review_states (user_id, expression_id) unique
 * constraint, so re-syncing an already-queued expression is a no-op.
 */
export async function enqueueForReview(userId: string, expressionId: string): Promise<void> {
  await supabase
    .from('review_states')
    .upsert({ user_id: userId, expression_id: expressionId }, { onConflict: 'user_id,expression_id', ignoreDuplicates: true });
}

/**
 * Some already-queued rows were saved before this screen understood the
 * "fr — ko" shape (e.g. a whole "Je pense à lui. — 나는 그를 생각해." line
 * saved as one expression). Before syncing, re-run pasteParser on every
 * still-pending row and replace any that would now split into something
 * different -- so old stuck rows get fixed up automatically instead of
 * uploading the wrong data forever.
 */
async function repairPendingExpression(row: PendingExpression): Promise<PendingExpression[]> {
  if (row.meaningKo !== undefined && row.meaningKo !== null) {
    return [row]; // already has a meaning recorded -- not one of the old bad rows
  }

  const rows = splitInputIntoRows(row.expressionFr);
  const isUnchanged = rows.length === 1 && rows[0].expressionFr === row.expressionFr && !rows[0].meaningKo;
  if (isUnchanged) return [row];

  await offlineDB.pendingExpressions.delete(row.clientId);
  const replacements: PendingExpression[] = rows.map((r) => ({
    clientId: crypto.randomUUID(),
    userId: row.userId,
    expressionFr: r.expressionFr,
    meaningKo: r.meaningKo,
    tags: r.tags,
    sourceType: row.sourceType,
    originalContext: row.originalContext,
    createdAt: row.createdAt,
    syncStatus: 'pending',
    lastError: null,
  }));
  await offlineDB.pendingExpressions.bulkPut(replacements);
  return replacements;
}

/**
 * Flushes everything in the offline queue. Safe to call repeatedly (on
 * mount, periodically, on reconnect) -- a row that fails is marked 'error'
 * and left for the next pass, and never blocks the rows after it.
 */
export async function syncPendingExpressions(userId: string): Promise<void> {
  const pending = await offlineDB.pendingExpressions.where({ userId }).and((row) => row.syncStatus !== 'synced').toArray();
  const needsAnalysis: AnalyzableRow[] = [];

  for (const original of pending) {
    let rowsToSync: PendingExpression[];
    try {
      rowsToSync = await repairPendingExpression(original);
    } catch {
      rowsToSync = [original];
    }

    for (const row of rowsToSync) {
      try {
        await offlineDB.pendingExpressions.update(row.clientId, { syncStatus: 'syncing' });

        const { data, error } = await supabase
          .from('expressions')
          .upsert(
            {
              user_id: row.userId,
              client_id: row.clientId,
              expression_fr: row.expressionFr,
              meaning_ko: row.meaningKo ?? null,
              tags: row.tags ?? [],
              source_type: row.sourceType,
              original_context: row.originalContext,
            },
            { onConflict: 'user_id,client_id' }
          )
          .select('id')
          .single();

        if (error || !data) {
          await offlineDB.pendingExpressions.update(row.clientId, {
            syncStatus: 'error',
            lastError: error?.message ?? 'unknown error',
          });
          continue;
        }

        await offlineDB.pendingExpressions.update(row.clientId, { syncStatus: 'synced', lastError: null });
        await enqueueForReview(row.userId, data.id);
        needsAnalysis.push({ expressionId: data.id, expressionFr: row.expressionFr, needsMeaning: !row.meaningKo });
      } catch (err) {
        await offlineDB.pendingExpressions.update(row.clientId, {
          syncStatus: 'error',
          lastError: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }
  }

  void triggerAutoAnalysis(needsAnalysis).catch(() => {});
}
