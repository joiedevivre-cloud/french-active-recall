import Dexie, { type EntityTable } from 'dexie';

// An expression captured while offline (or while we simply haven't confirmed
// the Supabase write yet). `clientId` is the same UUID that gets written to
// expressions.client_id, so re-syncing the same row twice is a harmless
// upsert instead of a duplicate (see supabase/migrations/0001_core_schema.sql,
// uq_expressions_user_client_id).
export interface PendingExpression {
  clientId: string;
  userId: string;
  expressionFr: string;
  sourceType: string;
  originalContext: string | null;
  createdAt: string; // ISO timestamp, set at capture time (not at sync time)
  syncStatus: 'pending' | 'syncing' | 'synced' | 'error';
  lastError: string | null;
}

class OfflineDB extends Dexie {
  pendingExpressions!: EntityTable<PendingExpression, 'clientId'>;

  constructor() {
    super('french-active-recall');
    this.version(1).stores({
      pendingExpressions: 'clientId, userId, syncStatus, createdAt',
    });
  }
}

export const offlineDB = new OfflineDB();

export function pendingSyncCount(userId: string): Promise<number> {
  return offlineDB.pendingExpressions
    .where({ userId })
    .filter((row) => row.syncStatus !== 'synced')
    .count();
}
