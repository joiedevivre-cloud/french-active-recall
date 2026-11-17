import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { allPendingExpressions, allPendingPasteBatches, type PendingExpression, type PendingPasteBatch } from '@/lib/db';
import { syncPendingExpressions } from '@/features/capture/addExpression';
import { syncPendingPasteBatches } from '@/features/paste-save/pasteSave';

function statusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return '대기중';
    case 'syncing':
      return '동기화중';
    case 'error':
      return '실패';
    default:
      return status;
  }
}

export default function SyncStatusPage() {
  const { user } = useAuth();
  const [expressions, setExpressions] = useState<PendingExpression[]>([]);
  const [batches, setBatches] = useState<PendingPasteBatch[]>([]);
  const [retrying, setRetrying] = useState(false);

  async function load() {
    if (!user) return;
    setExpressions(await allPendingExpressions(user.id));
    setBatches(await allPendingPasteBatches(user.id));
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function handleRetryAll() {
    if (!user || retrying) return;
    setRetrying(true);
    await Promise.all([syncPendingExpressions(user.id), syncPendingPasteBatches(user.id)]);
    await load();
    setRetrying(false);
  }

  const totalCount = expressions.length + batches.length;

  return (
    <div className="flex flex-col gap-4 p-5">
      <h1 className="text-lg font-bold">동기화 상태</h1>

      {!navigator.onLine && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          지금 오프라인 상태입니다. 온라인이 되면 자동으로 다시 시도합니다.
        </p>
      )}

      {totalCount === 0 ? (
        <p className="text-sm text-slate-400">동기화 대기중인 항목이 없습니다.</p>
      ) : (
        <>
          <button
            onClick={() => void handleRetryAll()}
            disabled={retrying}
            className="rounded-full bg-blue-600 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            {retrying ? '다시 시도중...' : '지금 다시 시도'}
          </button>

          {expressions.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-slate-500">표현 ({expressions.length})</p>
              <ul className="flex flex-col gap-2">
                {expressions.map((row) => (
                  <li key={row.clientId} className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{row.expressionFr}</span>
                      <span
                        className={
                          row.syncStatus === 'error'
                            ? 'text-xs text-red-500'
                            : 'text-xs text-slate-400'
                        }
                      >
                        {statusLabel(row.syncStatus)}
                      </span>
                    </div>
                    {row.lastError && (
                      <p className="mt-1 text-xs text-red-500">오류: {row.lastError}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {batches.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-slate-500">붙여넣기 배치 ({batches.length})</p>
              <ul className="flex flex-col gap-2">
                {batches.map((batch) => (
                  <li key={batch.batchClientId} className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{batch.rows.length}개 표현</span>
                      <span className={batch.syncStatus === 'error' ? 'text-xs text-red-500' : 'text-xs text-slate-400'}>
                        {statusLabel(batch.syncStatus)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-400">{batch.rawContent}</p>
                    {batch.lastError && <p className="mt-1 text-xs text-red-500">오류: {batch.lastError}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
