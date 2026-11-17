import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { QuickAddSheet } from '@/features/capture/QuickAddSheet';
import { useOfflineSync } from '@/features/capture/useOfflineSync';
import { useTodayExpressions } from '@/features/capture/useTodayExpressions';
import { usePasteOfflineSync } from '@/features/paste-save/usePasteOfflineSync';

export default function HomePage() {
  const { user } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { pendingCount, isOnline } = useOfflineSync();
  const { pendingCount: pastePendingCount } = usePasteOfflineSync();
  const { items: todayItems } = useTodayExpressions(refreshKey);

  const { data: dueCount } = useQuery({
    queryKey: ['due_review_count', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count } = await supabase
        .from('review_states')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user!.id)
        .lte('due_at', new Date().toISOString());
      return count ?? 0;
    },
  });

  const totalPending = pendingCount + pastePendingCount;

  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>오늘 복습할 표현: {dueCount ?? '-'}개</span>
        {!isOnline && <span className="text-amber-600">오프라인</span>}
        {totalPending > 0 && (
          <Link to="/sync-status" className="text-amber-600 underline">
            동기화 대기 {totalPending}건
          </Link>
        )}
      </div>

      <button
        onClick={() => setAddOpen(true)}
        className="flex h-32 w-full items-center justify-center rounded-3xl bg-blue-600 text-2xl font-bold text-white shadow-lg active:scale-95"
      >
        + 표현 추가
      </button>

      <Link
        to="/paste-save"
        className="flex items-center justify-center rounded-2xl border border-blue-600 py-3 text-base font-semibold text-blue-600 dark:text-blue-400"
      >
        붙여넣기 저장
      </Link>

      <div className="grid grid-cols-2 gap-3">
        <Link to="/class-mode" className="rounded-2xl border border-slate-200 p-4 text-center dark:border-slate-800">
          <div className="text-2xl">🎓</div>
          <div className="mt-1 text-sm font-medium">수업 모드</div>
        </Link>
        <Link to="/review" className="rounded-2xl border border-slate-200 p-4 text-center dark:border-slate-800">
          <div className="text-2xl">🔁</div>
          <div className="mt-1 text-sm font-medium">빠른 복습 시작</div>
        </Link>
        <Link to="/ai-chat" className="rounded-2xl border border-slate-200 p-4 text-center dark:border-slate-800">
          <div className="text-2xl">💬</div>
          <div className="mt-1 text-sm font-medium">AI 대화 시작</div>
        </Link>
        <Link to="/library" className="rounded-2xl border border-slate-200 p-4 text-center dark:border-slate-800">
          <div className="text-2xl">📚</div>
          <div className="mt-1 text-sm font-medium">전체 표현장</div>
        </Link>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-500">오늘 저장한 표현 ({todayItems.length})</h3>
        <ul className="flex flex-col gap-1">
          {todayItems.slice(0, 5).map((item) => (
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

      <QuickAddSheet open={addOpen} onClose={() => setAddOpen(false)} onSaved={() => setRefreshKey((k) => k + 1)} />
    </div>
  );
}
