import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { allPendingExpressions, type PendingExpression } from '@/lib/db';
import { analyzeChunk } from '@/features/ai-batch/aiBatchClient';
import { applyAnalysisResult } from '@/features/ai-batch/applyAnalysisResult';

type QuickFilter = 'all' | 'today' | 'week' | 'favorite';

const SOURCE_TYPE_LABELS: Record<string, string> = {
  manual: '직접입력',
  school: '학교 수업',
  tv5monde: 'TV5MONDE',
  daily: '일상 대화',
  news: '뉴스',
  video: '영상',
  ocr: '사진',
  voice: '음성',
  import: '가져오기',
  import_anki: 'Anki',
  b2_700: 'B2 700문장',
};

interface ExpressionRow {
  id: string;
  expression_fr: string;
  meaning_ko: string | null;
  cefr_level: string | null;
  source_type: string;
  is_favorite: boolean;
  ai_analysis_status: string;
  created_at: string;
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfWeekIso(): string {
  const d = new Date();
  const day = d.getDay() === 0 ? 6 : d.getDay() - 1; // Monday-start week
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function LibraryPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMeaning, setEditMeaning] = useState('');
  const [pending, setPending] = useState<PendingExpression[]>([]);

  useEffect(() => {
    if (!user) return;
    void allPendingExpressions(user.id).then(setPending);
  }, [user]);

  const { data: expressions = [], isLoading } = useQuery({
    queryKey: ['expressions', user?.id, quickFilter, search],
    enabled: !!user,
    // Background AI analysis (triggered right after a save) finishes
    // asynchronously -- poll while anything is still 'pending' so the
    // result shows up without the user having to manually refresh.
    refetchInterval: (query) => (query.state.data?.some((e) => e.ai_analysis_status === 'pending') ? 4000 : false),
    queryFn: async () => {
      let query = supabase
        .from('expressions')
        .select('id, expression_fr, meaning_ko, cefr_level, source_type, is_favorite, ai_analysis_status, created_at')
        .eq('user_id', user!.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      if (quickFilter === 'today') query = query.gte('created_at', startOfTodayIso());
      if (quickFilter === 'week') query = query.gte('created_at', startOfWeekIso());
      if (quickFilter === 'favorite') query = query.eq('is_favorite', true);
      if (search.trim()) query = query.ilike('expression_fr', `%${search.trim()}%`);

      const { data, error } = await query.limit(200);
      if (error) throw error;
      return data as ExpressionRow[];
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['expressions', user?.id] });

  const toggleFavorite = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: boolean }) => {
      const { error } = await supabase.from('expressions').update({ is_favorite: next }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const softDelete = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('expressions').update({ deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const saveMeaning = useMutation({
    mutationFn: async ({ id, meaning }: { id: string; meaning: string }) => {
      const { error } = await supabase.from('expressions').update({ meaning_ko: meaning }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      setEditingId(null);
    },
  });

  const [lastRetryError, setLastRetryError] = useState<{ id: string; message: string } | null>(null);

  const retryAnalysis = useMutation({
    mutationFn: async (expr: ExpressionRow) => {
      setLastRetryError(null);
      await supabase.from('expressions').update({ ai_analysis_status: 'pending' }).eq('id', expr.id);
      invalidate();
      const result = await analyzeChunk([expr.expression_fr]);
      if (result.status === 'failed') {
        // Surfaces the real HTTP status/body from the Edge Function (see
        // describeInvokeError in aiBatchClient.ts) instead of the generic
        // "non-2xx status code" message every failure used to show.
        setLastRetryError({ id: expr.id, message: result.error ?? 'unknown_error' });
      }
      await applyAnalysisResult(expr.id, result.status === 'success' ? result.results?.[0] ?? null : null);
    },
    onSettled: invalidate,
  });

  const filters: { key: QuickFilter; label: string }[] = useMemo(
    () => [
      { key: 'all', label: '전체' },
      { key: 'today', label: '오늘' },
      { key: 'week', label: '이번주' },
      { key: 'favorite', label: '즐겨찾기' },
    ],
    []
  );

  return (
    <div className="flex flex-col gap-4 p-5">
      <h1 className="text-lg font-bold">표현장</h1>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="표현 검색..."
        className="w-full rounded-xl border border-slate-300 p-3 text-sm dark:border-slate-700 dark:bg-slate-900"
      />

      <div className="flex gap-2 overflow-x-auto">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setQuickFilter(f.key)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm ${
              quickFilter === f.key
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-slate-400">불러오는 중...</p>}
      {!isLoading && expressions.length === 0 && pending.length === 0 && (
        <p className="text-sm text-slate-400">저장된 표현이 없습니다.</p>
      )}

      {quickFilter === 'all' && !search.trim() && pending.length > 0 && (
        <ul className="flex flex-col gap-2">
          {pending.map((row) => (
            <li key={row.clientId} className="rounded-2xl border border-amber-300 p-4 dark:border-amber-700">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-base font-medium">{row.expressionFr}</p>
                  <p className="mt-0.5 text-sm text-slate-500">{row.meaningKo || '뜻 없음'}</p>
                </div>
                <span className="whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  동기화 대기
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ul className="flex flex-col gap-2">
        {expressions.map((expr) => (
          <li key={expr.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-base font-medium">{expr.expression_fr}</p>
                {editingId === expr.id ? (
                  <div className="mt-1 flex gap-2">
                    <input
                      autoFocus
                      value={editMeaning}
                      onChange={(e) => setEditMeaning(e.target.value)}
                      className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
                    />
                    <button
                      onClick={() => saveMeaning.mutate({ id: expr.id, meaning: editMeaning })}
                      className="text-sm text-blue-600"
                    >
                      저장
                    </button>
                  </div>
                ) : expr.meaning_ko ? (
                  <p className="mt-0.5 text-sm text-slate-500">{expr.meaning_ko}</p>
                ) : expr.ai_analysis_status === 'failed' ? (
                  <div className="mt-0.5">
                    <p className="flex items-center gap-2 text-sm text-red-500">
                      분석 실패
                      <button
                        onClick={() => retryAnalysis.mutate(expr)}
                        disabled={retryAnalysis.isPending}
                        className="rounded-full border border-red-400 px-2 py-0.5 text-xs disabled:opacity-40"
                      >
                        재시도
                      </button>
                    </p>
                    {lastRetryError?.id === expr.id && (
                      <p className="mt-1 text-xs text-red-400">{lastRetryError.message}</p>
                    )}
                  </div>
                ) : (
                  <p className="mt-0.5 text-sm text-slate-400">AI 분석 중...</p>
                )}
                {(expr.cefr_level || SOURCE_TYPE_LABELS[expr.source_type]) && (
                  <p className="mt-1 text-xs text-slate-400">
                    {[expr.cefr_level, SOURCE_TYPE_LABELS[expr.source_type] ?? expr.source_type].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-2 text-sm">
                <button onClick={() => toggleFavorite.mutate({ id: expr.id, next: !expr.is_favorite })}>
                  {expr.is_favorite ? '⭐' : '☆'}
                </button>
                <button
                  onClick={() => {
                    setEditingId(expr.id);
                    setEditMeaning(expr.meaning_ko ?? '');
                  }}
                  className="text-slate-400"
                >
                  수정
                </button>
                <button
                  onClick={() => {
                    if (confirm('이 표현을 삭제할까요? (복습 이력은 보존되고, 복습 대상에서 제외됩니다)')) {
                      softDelete.mutate(expr.id);
                    }
                  }}
                  className="text-red-400"
                >
                  삭제
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
