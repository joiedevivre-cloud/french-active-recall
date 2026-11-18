import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { allPendingExpressions, type PendingExpression } from '@/lib/db';
import { analyzeChunk, analyzeSentencesInChunks, type BatchItemResult } from '@/features/ai-batch/aiBatchClient';
import { applyAnalysisResult, markAnalyzing } from '@/features/ai-batch/applyAnalysisResult';
import { effectiveAnalysisState } from '@/features/ai-batch/staleAnalysis';

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
  analysis_requested_at: string | null;
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMeaning, setEditMeaning] = useState('');
  const [pending, setPending] = useState<PendingExpression[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!user) return;
    void allPendingExpressions(user.id).then(setPending);
  }, [user]);

  const { data: expressions = [], isLoading } = useQuery({
    queryKey: ['expressions', user?.id, quickFilter, search],
    enabled: !!user,
    // Background AI analysis (triggered right after a save) finishes
    // asynchronously -- poll while anything genuinely still needs it, so
    // the result shows up without the user having to manually refresh.
    refetchInterval: (query) =>
      query.state.data?.some((e) => effectiveAnalysisState(toAnalysisInput(e)) === 'analyzing') ? 4000 : false,
    queryFn: async () => {
      let query = supabase
        .from('expressions')
        .select(
          'id, expression_fr, meaning_ko, cefr_level, source_type, is_favorite, ai_analysis_status, analysis_requested_at, created_at'
        )
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
      // The user editing this directly is exactly what meaning_ko_user_edited
      // protects from a later AI re-analysis silently overwriting.
      const { error } = await supabase.from('expressions').update({ meaning_ko: meaning, meaning_ko_user_edited: true }).eq('id', id);
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
      await markAnalyzing([expr.id]);
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

  async function runBatchReanalysis(rows: ExpressionRow[]) {
    if (rows.length === 0) return;
    await markAnalyzing(rows.map((r) => r.id));
    invalidate();
    setBatchProgress({ done: 0, total: rows.length });

    const chunkResults = await analyzeSentencesInChunks(rows.map((r) => r.expression_fr), (done, total) =>
      setBatchProgress({ done, total })
    );
    const byText = new Map<string, BatchItemResult | null>();
    for (const chunk of chunkResults) {
      chunk.sentences.forEach((sentence, i) => {
        byText.set(sentence, chunk.status === 'success' ? chunk.results?.[i] ?? null : null);
      });
    }
    await Promise.all(rows.map((row) => applyAnalysisResult(row.id, byText.get(row.expression_fr) ?? null)));

    setBatchProgress(null);
    setSelectedIds(new Set());
    invalidate();
  }

  const filters: { key: QuickFilter; label: string }[] = useMemo(
    () => [
      { key: 'all', label: '전체' },
      { key: 'today', label: '오늘' },
      { key: 'week', label: '이번주' },
      { key: 'favorite', label: '즐겨찾기' },
    ],
    []
  );

  function toAnalysisInput(e: ExpressionRow) {
    return { aiAnalysisStatus: e.ai_analysis_status, analysisRequestedAt: e.analysis_requested_at, meaningKo: e.meaning_ko };
  }

  const incompleteRows = expressions.filter((e) => {
    const state = effectiveAnalysisState(toAnalysisInput(e));
    return state === 'not_requested' || state === 'failed' || state === 'stalled';
  });
  const failedOnlyRows = expressions.filter((e) => {
    const state = effectiveAnalysisState(toAnalysisInput(e));
    return state === 'failed' || state === 'stalled';
  });
  const noMeaningRows = expressions.filter((e) => !e.meaning_ko);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">표현장</h1>
        <div className="flex gap-2 text-xs">
          <button onClick={() => invalidate()} className="rounded-full border border-slate-300 px-3 py-1 dark:border-slate-700">
            상태 새로고침
          </button>
          <button
            onClick={() => {
              setSelectionMode((v) => !v);
              setSelectedIds(new Set());
            }}
            className={`rounded-full px-3 py-1 ${selectionMode ? 'bg-blue-600 text-white' : 'border border-slate-300 dark:border-slate-700'}`}
          >
            {selectionMode ? '선택 종료' : '선택'}
          </button>
        </div>
      </div>

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

      {selectionMode && (
        <div className="flex flex-col gap-2 rounded-2xl border border-blue-200 p-3 dark:border-blue-800">
          <div className="flex flex-wrap gap-2 text-xs">
            <button onClick={() => setSelectedIds(new Set(expressions.map((e) => e.id)))} className="rounded-full border border-slate-300 px-3 py-1 dark:border-slate-700">
              전체 선택
            </button>
            <button onClick={() => setSelectedIds(new Set())} className="rounded-full border border-slate-300 px-3 py-1 dark:border-slate-700">
              선택 해제
            </button>
            <button onClick={() => setSelectedIds(new Set(failedOnlyRows.map((e) => e.id)))} className="rounded-full border border-slate-300 px-3 py-1 dark:border-slate-700">
              실패한 표현만 ({failedOnlyRows.length})
            </button>
            <button onClick={() => setSelectedIds(new Set(noMeaningRows.map((e) => e.id)))} className="rounded-full border border-slate-300 px-3 py-1 dark:border-slate-700">
              뜻 없는 표현만 ({noMeaningRows.length})
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void runBatchReanalysis(expressions.filter((e) => selectedIds.has(e.id)))}
              disabled={selectedIds.size === 0 || !!batchProgress}
              className="flex-1 rounded-full bg-blue-600 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              선택한 표현 AI 분석 ({selectedIds.size})
            </button>
            <button
              onClick={() => void runBatchReanalysis(incompleteRows)}
              disabled={incompleteRows.length === 0 || !!batchProgress}
              className="flex-1 rounded-full border border-blue-600 py-2 text-sm font-semibold text-blue-600 disabled:opacity-40 dark:text-blue-400"
            >
              미완료 전체 다시 분석 ({incompleteRows.length})
            </button>
          </div>
          {batchProgress && (
            <p className="text-xs text-slate-400">
              분석중... {batchProgress.done}/{batchProgress.total}
            </p>
          )}
        </div>
      )}

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
        {expressions.map((expr) => {
          const state = effectiveAnalysisState(toAnalysisInput(expr));
          return (
            <li key={expr.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
              <div className="flex items-start justify-between gap-2">
                {selectionMode && (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(expr.id)}
                    onChange={() => toggleSelected(expr.id)}
                    className="mt-1"
                  />
                )}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => !selectionMode && navigate(`/expression/${expr.id}`)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && !selectionMode) navigate(`/expression/${expr.id}`);
                  }}
                  className="flex-1 cursor-pointer text-left"
                >
                  <p className="text-base font-medium">{expr.expression_fr}</p>
                  {editingId === expr.id ? (
                    <div className="mt-1 flex gap-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        autoFocus
                        value={editMeaning}
                        onChange={(e) => setEditMeaning(e.target.value)}
                        className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
                      />
                      <button onClick={() => saveMeaning.mutate({ id: expr.id, meaning: editMeaning })} className="text-sm text-blue-600">
                        저장
                      </button>
                    </div>
                  ) : expr.meaning_ko ? (
                    <p className="mt-0.5 text-sm text-slate-500">{expr.meaning_ko}</p>
                  ) : state === 'failed' || state === 'stalled' ? (
                    <div className="mt-0.5">
                      <p className="flex items-center gap-2 text-sm text-red-500">
                        {state === 'stalled' ? '응답 없음' : '분석 실패'}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            retryAnalysis.mutate(expr);
                          }}
                          disabled={retryAnalysis.isPending}
                          className="rounded-full border border-red-400 px-2 py-0.5 text-xs disabled:opacity-40"
                        >
                          재시도
                        </button>
                      </p>
                      {lastRetryError?.id === expr.id && <p className="mt-1 text-xs text-red-400">{lastRetryError.message}</p>}
                    </div>
                  ) : state === 'analyzing' ? (
                    <p className="mt-0.5 text-sm text-slate-400">AI 분석 중...</p>
                  ) : (
                    <p className="mt-0.5 flex items-center gap-2 text-sm text-slate-400">
                      분석 전
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          retryAnalysis.mutate(expr);
                        }}
                        className="rounded-full border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-700"
                      >
                        분석하기
                      </button>
                    </p>
                  )}
                  {(expr.cefr_level || SOURCE_TYPE_LABELS[expr.source_type]) && (
                    <p className="mt-1 text-xs text-slate-400">
                      {[expr.cefr_level, SOURCE_TYPE_LABELS[expr.source_type] ?? expr.source_type].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
                {!selectionMode && (
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
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
