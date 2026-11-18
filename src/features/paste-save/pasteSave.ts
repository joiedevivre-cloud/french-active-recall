import { supabase } from '@/lib/supabase';
import { offlineDB, type PendingPasteBatch, type PendingPasteRow } from '@/lib/db';
import { enqueueForReview } from '@/features/capture/addExpression';
import { triggerAutoAnalysis } from '@/features/ai-batch/autoAnalyze';
import type { SourceType } from '@/lib/csvImport';

/**
 * Minimal shape savePasteBatch needs from a row. A plain PasteParsedRow
 * (src/lib/pasteParser.ts) already satisfies this; the AI-batch flow
 * (src/features/ai-batch/) passes the same shape plus its extra analysis
 * fields.
 */
export interface SaveBatchRowInput {
  expressionFr: string;
  meaningKo: string;
  tags: string[];
  correctedFr?: string | null;
  keyPhrase?: string | null;
  grammarNote?: string | null;
  cefrLevel?: string | null;
  exampleFr?: string | null;
  exampleTranslationKo?: string | null;
}

export interface SaveBatchInput {
  userId: string;
  rawContent: string;
  sourceType: SourceType;
  sourceLabel: string | null;
  /** Only rows the caller wants saved -- i.e. already filtered to status 'new'. */
  rows: SaveBatchRowInput[];
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

function toPendingRows(rows: SaveBatchRowInput[]): PendingPasteRow[] {
  return rows.map((row) => ({
    rowClientId: crypto.randomUUID(),
    expressionFr: row.expressionFr,
    meaningKo: row.meaningKo,
    tags: row.tags,
    isSentence: /[.?!]$/.test(row.expressionFr.trim()),
    correctedFr: row.correctedFr ?? null,
    keyPhrase: row.keyPhrase ?? null,
    grammarNote: row.grammarNote ?? null,
    cefrLevel: row.cefrLevel ?? null,
    exampleFr: row.exampleFr ?? null,
    exampleTranslationKo: row.exampleTranslationKo ?? null,
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
          corrected_fr: row.correctedFr ?? null,
          key_phrase: row.keyPhrase ?? null,
          grammar_note: row.grammarNote ?? null,
          cefr_level: row.cefrLevel ?? null,
        },
        { onConflict: 'user_id,client_id' }
      )
      .select('id')
      .single();
    if (error || !expression) throw error ?? new Error('expression_insert_failed');

    if (row.exampleFr) {
      // expression_examples has no client-side idempotency key of its own,
      // so a retry of this same batch must check-then-write rather than
      // upsert, or it would insert a second example every retry.
      const { data: existingExample } = await supabase
        .from('expression_examples')
        .select('id')
        .eq('expression_id', expression.id)
        .limit(1)
        .maybeSingle();

      if (existingExample) {
        await supabase
          .from('expression_examples')
          .update({ sentence_fr: row.exampleFr, translation_ko: row.exampleTranslationKo ?? null })
          .eq('id', existingExample.id);
      } else {
        await supabase.from('expression_examples').insert({
          expression_id: expression.id,
          sentence_fr: row.exampleFr,
          translation_ko: row.exampleTranslationKo ?? null,
          is_user_created: false,
        });
      }
    }

    await enqueueForReview(batch.userId, expression.id);
    saved.push({
      rowClientId: row.rowClientId,
      expressionId: expression.id,
      expressionFr: row.expressionFr,
      meaningKo: row.meaningKo,
    });
  }

  await offlineDB.pendingPasteBatches.update(batch.batchClientId, { syncStatus: 'synced', lastError: null });

  // Meaning analysis only for rows the user didn't already give a meaning
  // to (a "fr — ko" paste or /ai-batch result never re-spends an AI call on
  // a known meaning) -- but EVERY saved row gets the sentence/word analysis
  // for the 단어장 (see triggerAutoAnalysis).
  void triggerAutoAnalysis(
    saved.map((row) => ({ expressionId: row.expressionId, expressionFr: row.expressionFr, needsMeaning: !row.meaningKo }))
  ).catch(() => {});

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
