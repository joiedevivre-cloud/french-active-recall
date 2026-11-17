import { supabase } from '@/lib/supabase';
import { offlineDB, type PendingPasteBatch, type PendingPasteRow } from '@/lib/db';
import { enqueueForReview } from '@/features/capture/addExpression';
import type { PasteParsedRow } from '@/lib/pasteParser';
import type { SourceType } from '@/lib/csvImport';

export interface SaveBatchInput {
  userId: string;
  rawContent: string;
  sourceType: SourceType;
  sourceLabel: string | null;
  /** Only rows the caller wants saved -- i.e. already filtered to status 'new'. */
  rows: PasteParsedRow[];
}

export interface SavedRowResult {
  rowClientId: string;
  expressionId: string;
  expressionFr: string;
  meaningKo: string;
}

export interface SaveBatchResult {
  stored: 'online' | 'offline';
  batchClientId: string;
  /** Only populated when stored === 'online'. */
  saved: SavedRowResult[];
}

function toPendingRows(rows: PasteParsedRow[]): PendingPasteRow[] {
  return rows.map((row) => ({
    rowClientId: crypto.randomUUID(),
    expressionFr: row.expressionFr,
    meaningKo: row.meaningKo,
    tags: row.tags,
    isSentence: row.isSentence,
  }));
}

/**
 * Persists the raw paste + its parsed rows to IndexedDB FIRST, then tries to
 * sync immediately. A network failure partway through never loses the
 * pasted content -- it just stays queued for the next reconnect.
 */
export async function savePasteBatch(input: SaveBatchInput): Promise<SaveBatchResult> {
  const batchClientId = crypto.randomUUID();
  const batch: PendingPasteBatch = {
    batchClientId,
    userId: input.userId,
    rawContent: input.rawContent,
    sourceType: input.sourceType,
    sourceLabel: input.sourceLabel,
    rows: toPendingRows(input.rows),
    createdAt: new Date().toISOString(),
    syncStatus: 'pending',
    lastError: null,
  };

  await offlineDB.pendingPasteBatches.put(batch);

  if (!navigator.onLine) {
    return { stored: 'offline', batchClientId, saved: [] };
  }

  try {
    const saved = await syncOnePasteBatch(batch);
    return { stored: 'online', batchClientId, saved };
  } catch {
    return { stored: 'offline', batchClientId, saved: [] };
  }
}

async function syncOnePasteBatch(batch: PendingPasteBatch): Promise<SavedRowResult[]> {
  const { data: rawNote, error: rawNoteError } = await supabase
    .from('raw_notes')
    .upsert(
      {
        user_id: batch.userId,
        client_id: batch.batchClientId,
        content: batch.rawContent,
        source_type: batch.sourceType,
      },
      { onConflict: 'user_id,client_id' }
    )
    .select('id')
    .single();
  if (rawNoteError || !rawNote) throw rawNoteError ?? new Error('raw_note_insert_failed');

  const saved: SavedRowResult[] = [];
  for (const row of batch.rows) {
    const { data: expression, error } = await supabase
      .from('expressions')
      .upsert(
        {
          user_id: batch.userId,
          client_id: row.rowClientId,
          expression_fr: row.expressionFr,
          meaning_ko: row.meaningKo || null,
          tags: row.tags,
          source_type: batch.sourceType,
          source_label: batch.sourceLabel,
          raw_note_id: rawNote.id,
        },
        { onConflict: 'user_id,client_id' }
      )
      .select('id')
      .single();
    if (error || !expression) throw error ?? new Error('expression_insert_failed');

    await enqueueForReview(batch.userId, expression.id);
    saved.push({
      rowClientId: row.rowClientId,
      expressionId: expression.id,
      expressionFr: row.expressionFr,
      meaningKo: row.meaningKo,
    });
  }

  await offlineDB.pendingPasteBatches.update(batch.batchClientId, { syncStatus: 'synced', lastError: null });
  return saved;
}

/** Call on reconnect: flushes every not-yet-synced paste batch, in order. */
export async function syncPendingPasteBatches(userId: string): Promise<void> {
  const pending = await offlineDB.pendingPasteBatches
    .where({ userId })
    .filter((batch) => batch.syncStatus !== 'synced')
    .toArray();

  for (const batch of pending) {
    await offlineDB.pendingPasteBatches.update(batch.batchClientId, { syncStatus: 'syncing' });
    try {
      await syncOnePasteBatch(batch);
    } catch (err) {
      await offlineDB.pendingPasteBatches.update(batch.batchClientId, {
        syncStatus: 'error',
        lastError: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }
}

/** "이번 저장 전체 취소": soft-deletes everything just saved. Leaves the raw
 * note itself untouched (raw_notes is append-only / preservation-only). */
export async function undoSavedRows(expressionIds: string[]): Promise<void> {
  if (expressionIds.length === 0) return;
  await supabase.from('expressions').update({ deleted_at: new Date().toISOString() }).in('id', expressionIds);
}
