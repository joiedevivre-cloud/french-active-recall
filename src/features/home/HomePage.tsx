import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { QuickAddSheet } from '@/features/capture/QuickAddSheet';
import { useOfflineSync } from '@/features/capture/useOfflineSync';

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function HomePage() {
  const { user } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const { pendingCount, isOnline } = useOfflineSync();

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

  const { data: todayCount } = useQuery({
    queryKey: ['today_saved_count', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count } = await supabase
        .from('expressions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user!.id)
        .is('deleted_at', null)
        .gte('created_at', startOfTodayIso());
      return count ?? 0;
    },
  });

  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>오늘 복습할 표현: {dueCount ?? '-'}개</span>
        {!isOnline && <span className="text-amber-600">오프라인</span>}
        {pendingCount > 0 && <span className="text-amber-600">동기화 대기 {pendingCount}건</span>}
      </div>

      <button
        onClick={() => setAddOpen(true)}
        className="flex h-32 w-full items-center justify-center rounded-3xl bg-blue-600 text-2xl font-bold text-white shadow-lg active:scale-95"
      >
        + 표현 추가
      </button>

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
        <h3 className="mb-2 text-sm font-semibold text-slate-500">오늘 저장한 표현: {todayCount ?? 0}개</h3>
      </div>

      <QuickAddSheet open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
