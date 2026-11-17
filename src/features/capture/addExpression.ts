import { supabase } from '@/lib/supabase';
import { offlineDB } from '@/lib/db';
import { normalizeFr } from '@/lib/normalizeFr';

export interface AddExpressionInput {
  userId: string;
  expressionFr: string;
  sourceType: string;
  originalContext?: string | null;
}

export interface AddExpressionResult {
  stored: 'online' | 'offline';
  expressionId: string | null;
  possibleDuplicate: { id: string; expression_fr: string } | null;
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

/**
 * Saves the raw expression text immediately (spec requirement: never make
 * the user wait for AI analysis). Falls back to an IndexedDB queue -- not an
 * error toast -- whenever we're offline or the network write itself fails,
 * so the user's input is never lost mid-class.
 */
export async function addExpression(input: AddExpressionInput): Promise<AddExpressionResult> {
  const clientId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  let possibleDuplicate: { id: string; expression_fr: string } | null = null;
  if (navigator.onLine) {
    try {
      possibleDuplicate = await findPossibleDuplicate(input.userId, input.expressionFr);
    } catch {
      // Duplicate check is best-effort only; never block saving on it.
    }
  }

  const queueOffline = async (lastError: string | null) => {
    await offlineDB.pendingExpressions.put({
      clientId,
      userId: input.userId,
      expressionFr: input.expressionFr,
      sourceType: input.sourceType,
      originalContext: input.originalContext ?? null,
      createdAt,
      syncStatus: 'pending',
      lastError,
    });
  };

  if (!navigator.onLine) {
    await queueOffline(null);
    return { stored: 'offline', expressionId: null, possibleDuplicate };
  }

  const { data, error } = await supabase
    .from('expressions')
    .upsert(
      {
        user_id: input.userId,
        client_id: clientId,
        expression_fr: input.expressionFr,
        source_type: input.sourceType,
        original_context: input.originalContext ?? null,
      },
      { onConflict: 'user_id,client_id' }
    )
    .select('id')
    .single();

  if (error || !data) {
    await queueOffline(error?.message ?? 'unknown error');
    return { stored: 'offline', expressionId: null, possibleDuplicate };
  }

  await enqueueForReview(input.userId, data.id);

  // Fire-and-forget: AI analysis must never block the save flow or a
  // continuous-entry session in class mode.
  void supabase.functions.invoke('analyze-expression', { body: { expressionId: data.id } }).catch(() => {});

  return { stored: 'online', expressionId: data.id, possibleDuplicate };
}

/**
 * Spec requirement: saving an expression immediately adds it to the review
 * queue (due_at = now), independent of whether/when AI analysis finishes.
 * Idempotent via the review_states (user_id, expression_id) unique
 * constraint, so re-syncing an already-queued expression is a no-op.
 */
async function enqueueForReview(userId: string, expressionId: string): Promise<void> {
  await supabase
    .from('review_states')
    .upsert({ user_id: userId, expression_id: expressionId }, { onConflict: 'user_id,expression_id', ignoreDuplicates: true });
}

/** Flushes everything in the offline queue. Call on reconnect. */
export async function syncPendingExpressions(userId: string): Promise<void> {
  const pending = await offlineDB.pendingExpressions.where({ userId }).and((row) => row.syncStatus !== 'synced').toArray();

  for (const row of pending) {
    await offlineDB.pendingExpressions.update(row.clientId, { syncStatus: 'syncing' });

    const { data, error } = await supabase
      .from('expressions')
      .upsert(
        {
          user_id: row.userId,
          client_id: row.clientId,
          expression_fr: row.expressionFr,
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
    void supabase.functions.invoke('analyze-expression', { body: { expressionId: data.id } }).catch(() => {});
  }
}
