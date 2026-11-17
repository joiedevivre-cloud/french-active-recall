import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QuickAddForm } from '@/features/capture/QuickAddForm';
import { useOfflineSync } from '@/features/capture/useOfflineSync';
import { useTodayExpressions } from '@/features/capture/useTodayExpressions';

export default function ClassMode() {
  const navigate = useNavigate();
  const { pendingCount, isOnline } = useOfflineSync();
  const [refreshKey, setRefreshKey] = useState(0);
  const { items, loading } = useTodayExpressions(refreshKey);

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">수업 모드</h1>
        <span className="text-xs text-slate-400">
          {isOnline ? '연결됨' : `오프라인 저장중 (${pendingCount})`}
        </span>
      </div>

      <QuickAddForm sourceType="school" silent onSaved={() => setRefreshKey((k) => k + 1)} />

      <div>
        <p className="mb-1 text-xs font-medium text-slate-500">오늘 저장한 표현 ({items.length})</p>
        {loading && items.length === 0 && <p className="text-sm text-slate-400">불러오는 중...</p>}
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800"
            >
              <span>{item.expressionFr}</span>
              {!item.synced && (
                <span className="whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  동기화 대기
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <button
        onClick={() => navigate('/review?scope=today')}
        className="mt-2 rounded-full border border-blue-600 py-3 text-sm font-semibold text-blue-600 dark:text-blue-400"
      >
        오늘 배운 표현 복습하기 (5분)
      </button>
    </div>
  );
}
