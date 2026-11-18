import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

interface GrammarSkillRow {
  tag: string;
  total_attempts: number;
  correct_attempts: number;
}

function startOfDaysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data: dueCount } = useQuery({
    queryKey: ['dashboard-due-count', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count } = await supabase.from('review_states').select('id', { count: 'exact', head: true }).eq('user_id', user!.id).lte('due_at', new Date().toISOString());
      return count ?? 0;
    },
  });

  const { data: nextDue } = useQuery({
    queryKey: ['dashboard-next-due', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from('review_states').select('due_at').eq('user_id', user!.id).gt('due_at', new Date().toISOString()).order('due_at', { ascending: true }).limit(1).maybeSingle();
      return data?.due_at ?? null;
    },
  });

  const { data: todayCompleted } = useQuery({
    queryKey: ['dashboard-today-completed', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count } = await supabase.from('review_attempts').select('id', { count: 'exact', head: true }).eq('user_id', user!.id).gte('created_at', startOfDaysAgoIso(0));
      return count ?? 0;
    },
  });

  const { data: newThisWeek } = useQuery({
    queryKey: ['dashboard-new-this-week', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count } = await supabase.from('review_states').select('id', { count: 'exact', head: true }).eq('user_id', user!.id).gte('created_at', startOfDaysAgoIso(7));
      return count ?? 0;
    },
  });

  const { data: weekHistory } = useQuery({
    queryKey: ['dashboard-week-history', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from('review_attempts').select('created_at, self_rating').eq('user_id', user!.id).gte('created_at', startOfDaysAgoIso(6));
      const byDay = new Map<string, { total: number; again: number }>();
      for (const row of data ?? []) {
        const day = row.created_at.slice(0, 10);
        const entry = byDay.get(day) ?? { total: 0, again: 0 };
        entry.total++;
        if (row.self_rating === 'again') entry.again++;
        byDay.set(day, entry);
      }
      return Array.from(byDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, stats]) => ({ day, ...stats }));
    },
  });

  const { data: grammarSkills } = useQuery({
    queryKey: ['dashboard-grammar-skills', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from('grammar_skills').select('tag, total_attempts, correct_attempts').eq('user_id', user!.id).order('total_attempts', { ascending: false }).limit(10);
      return (data ?? []) as GrammarSkillRow[];
    },
  });

  const { data: avgRetrievability } = useQuery({
    queryKey: ['dashboard-avg-retrievability', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from('review_states').select('last_retrievability').eq('user_id', user!.id).not('last_retrievability', 'is', null);
      const values = (data ?? []).map((r) => r.last_retrievability as number);
      if (values.length === 0) return null;
      return values.reduce((a, b) => a + b, 0) / values.length;
    },
  });

  const { data: longTermCount } = useQuery({
    queryKey: ['dashboard-long-term-count', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { count } = await supabase.from('review_states').select('id', { count: 'exact', head: true }).eq('user_id', user!.id).eq('state', 'review');
      return count ?? 0;
    },
  });

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">학습 대시보드</h1>
        <button onClick={() => navigate('/today')} className="text-sm text-blue-600 underline">
          오늘의 학습 →
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="오늘 완료" value={todayCompleted ?? 0} />
        <StatCard label="오늘 남음" value={dueCount ?? 0} />
        <StatCard label="최근 7일 신규" value={newThisWeek ?? 0} />
        <StatCard label="장기 복습 중" value={longTermCount ?? 0} />
      </div>

      <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
        <p className="text-sm text-slate-400">다음 복습 예정</p>
        <p className="mt-1 font-medium">{nextDue ? new Date(nextDue).toLocaleString('ko-KR') : '없음'}</p>
      </div>

      <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
        <p className="text-sm text-slate-400">
          예상 기억 유지율 {avgRetrievability != null && <span className="text-xs">(FSRS 추정값, 실제 측정치 아님)</span>}
        </p>
        <p className="mt-1 text-2xl font-semibold">{avgRetrievability != null ? `${Math.round(avgRetrievability * 100)}%` : '데이터 없음'}</p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-bold">최근 7일 학습 기록</h2>
        <ul className="flex flex-col gap-1">
          {(weekHistory ?? []).length === 0 && <li className="text-sm text-slate-400">기록 없음</li>}
          {(weekHistory ?? []).map((d) => (
            <li key={d.day} className="flex items-center justify-between text-sm">
              <span>{d.day}</span>
              <span className="text-slate-500">
                {d.total}개 · 오답 {d.again}개
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold">문법별 숙련도</h2>
        <ul className="flex flex-col gap-2">
          {(grammarSkills ?? []).length === 0 && <li className="text-sm text-slate-400">아직 작문 연습 기록이 없습니다.</li>}
          {(grammarSkills ?? []).map((g) => {
            const rate = g.total_attempts > 0 ? Math.round((g.correct_attempts / g.total_attempts) * 100) : 0;
            return (
              <li key={g.tag} className="flex items-center justify-between text-sm">
                <span>{g.tag}</span>
                <span className={rate < 60 ? 'text-amber-600' : 'text-slate-500'}>
                  {rate}% ({g.correct_attempts}/{g.total_attempts})
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-slate-200 p-4 text-center dark:border-slate-800">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-slate-400">{label}</p>
    </div>
  );
}
