import { useMemo } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useVocabularyData } from '@/features/vocabulary/useVocabularyData';
import {
  FILTER_LABELS,
  SORT_LABELS,
  filterAndSort,
  isDueToday,
  isVocabularyFilter,
  isVocabularySort,
  summarize,
} from '@/features/vocabulary/vocabularyIndex';
import { posLabel } from '@/lib/grammarTerms';
import { useScrollRestore } from '@/lib/useScrollRestore';

/**
 * /vocabulary -- 단어장 list. Read-only over existing data (no AI calls).
 * Search / filter / sort live in the URL (?q=&f=&s=) so "back" from a
 * lemma restores them exactly; scroll position is restored too.
 */
export default function VocabularyListPage() {
  const [params, setParams] = useSearchParams();
  const { entries, data, isLoading, error } = useVocabularyData();

  // Old links (/vocabulary?lemma=ID, used by the previous screen) -> new detail route.
  const legacyLemma = params.get('lemma');

  const query = params.get('q') ?? '';
  const filterParam = params.get('f');
  const sortParam = params.get('s');
  const filter = isVocabularyFilter(filterParam) ? filterParam : 'all';
  const sort = isVocabularySort(sortParam) ? sortParam : 'recent';

  const setParam = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(params);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const visible = useMemo(() => filterAndSort(entries, { query, filter, sort }), [entries, query, filter, sort]);
  const summary = useMemo(() => {
    const linked = new Set((data?.links ?? []).map((l) => l.expression_id));
    return summarize(entries, (data?.expressions ?? []).map((e) => e.id), linked);
  }, [entries, data]);

  useScrollRestore('vocabulary-list', !isLoading);

  if (legacyLemma) return <Navigate to={`/vocabulary/${legacyLemma}`} replace />;

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-bold">단어장</h1>

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <Stat label="단어" value={summary.lemmaCount} />
        <Stat label="쓰임" value={summary.usageCount} />
        <Stat label="오늘 복습" value={summary.dueToday} />
        <Stat label="단어 분석 대기" value={summary.analysisPending} />
        <Stat label="단어 분석 실패" value={summary.analysisFailed} />
        <Stat label="단어장 미반영 문장" value={summary.unanalyzedExpressions} />
      </div>

      <input
        value={query}
        onChange={(e) => setParam('q', e.target.value, '')}
        placeholder="단어·활용형·뜻·패턴·예문 검색"
        className="w-full rounded-xl border border-slate-300 p-3 text-sm dark:border-slate-700 dark:bg-slate-900"
      />

      <div className="flex flex-wrap gap-1.5 text-xs">
        {FILTER_LABELS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setParam('f', key, 'all')}
            className={`rounded-full px-3 py-1 ${filter === key ? 'bg-blue-600 text-white' : 'border border-slate-300 dark:border-slate-700'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-500">
        정렬
        <select
          value={sort}
          onChange={(e) => setParam('s', e.target.value, 'recent')}
          className="rounded-lg border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700"
        >
          {SORT_LABELS.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <span className="ml-auto">{visible.length}개</span>
      </label>

      {isLoading && <p className="text-sm text-slate-400">불러오는 중...</p>}
      {error && <p className="text-sm text-red-500">불러오기 실패: {error instanceof Error ? error.message : String(error)}</p>}
      {!isLoading && entries.length === 0 && <p className="text-sm text-slate-400">아직 단어장에 단어가 없습니다. 표현을 저장하면 문장 분석 후 자동으로 추가됩니다.</p>}
      {!isLoading && entries.length > 0 && visible.length === 0 && <p className="text-sm text-slate-400">조건에 맞는 단어가 없습니다.</p>}

      <ul className="flex flex-col gap-2">
        {visible.map((e) => (
          <li key={e.lemma.id}>
            <Link
              to={`/vocabulary/${e.lemma.id}`}
              className="block rounded-2xl border border-slate-200 p-3 dark:border-slate-800"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-base font-semibold">{e.lemma.lemma}</span>
                {e.lemma.part_of_speech && <span className="text-xs text-slate-400">{posLabel(e.lemma.part_of_speech)}</span>}
                {e.isFavorite && <span className="text-xs">⭐</span>}
                {e.needsAnalysis && <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800">분석 필요</span>}
              </div>
              {e.representativeMeaning && <p className="mt-0.5 truncate text-sm text-slate-600 dark:text-slate-300">{e.representativeMeaning}</p>}
              <p className="mt-1 text-xs text-slate-400">
                쓰임 {e.usageCount} · 문장 {e.expressionCount}
                {e.nextDueAt && (
                  <span className={isDueToday(e) ? ' text-blue-600 dark:text-blue-400' : ''}>
                    {' '}
                    · 복습 {isDueToday(e) ? '오늘' : new Date(e.nextDueAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
                  </span>
                )}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-900">
      <p className="text-base font-semibold">{value}</p>
      <p className="text-[11px] text-slate-400">{label}</p>
    </div>
  );
}
