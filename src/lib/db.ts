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
  meaningKo?: string | null;
  tags?: string[];
  sourceType: string;
  originalContext: string | null;
  createdAt: string; // ISO timestamp, set at capture time (not at sync time)
  syncStatus: 'pending' | 'syncing' | 'synced' | 'error';
  lastError: string | null;
}

export interface PendingPasteRow {
  /** Stable per-row id within the batch -- becomes this row's expressions.client_id. */
  rowClientId: string;
  expressionFr: string;
  meaningKo: string;
  tags: string[];
  isSentence: boolean;
}

/**
 * A whole "붙여넣기 저장" submission, kept together so the raw note and its
 * rows sync as one unit and in the right order (the raw_notes row must exist
 * -- or at least be upserted in the same pass -- before the expressions that
 * reference raw_note_id).
 */
export interface PendingPasteBatch {
  batchClientId: string; // also used as raw_notes.client_id
  userId: string;
  rawContent: string;
  sourceType: string;
  sourceLabel: string | null;
  rows: PendingPasteRow[];
  createdAt: string;
  syncStatus: 'pending' | 'syncing' | 'synced' | 'error';
  lastError: string | null;
}

class OfflineDB extends Dexie {
  pendingExpressions!: EntityTable<PendingExpression, 'clientId'>;
  pendingPasteBatches!: EntityTable<PendingPasteBatch, 'batchClientId'>;

  constructor() {
    super('french-active-recall');
    this.version(1).stores({
      pendingExpressions: 'clientId, userId, syncStatus, createdAt',
    });
    this.version(2).stores({
      pendingExpressions: 'clientId, userId, syncStatus, createdAt',
      pendingPasteBatches: 'batchClientId, userId, syncStatus, createdAt',
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

export async function pendingPasteSyncCount(userId: string): Promise<number> {
  return offlineDB.pendingPasteBatches
    .where({ userId })
    .filter((row) => row.syncStatus !== 'synced')
    .count();
}

/** All not-yet-synced single-expression saves, newest first. Used by the
 * sync status screen and by views that need to show "아직 서버에 없지만
 * 이미 저장된" items (Home/수업 모드/표현장). */
export async function allPendingExpressions(userId: string): Promise<PendingExpression[]> {
  const rows = await offlineDB.pendingExpressions
    .where({ userId })
    .filter((row) => row.syncStatus !== 'synced')
    .toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function allPendingPasteBatches(userId: string): Promise<PendingPasteBatch[]> {
  const rows = await offlineDB.pendingPasteBatches
    .where({ userId })
    .filter((row) => row.syncStatus !== 'synced')
    .toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
