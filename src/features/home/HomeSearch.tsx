import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useVocabularyData } from '@/features/vocabulary/useVocabularyData';
import { filterAndSort } from '@/features/vocabulary/vocabularyIndex';
import { buildSearchText, matchesSearch } from '@/lib/search';
import { posLabel } from '@/lib/grammarTerms';

const MAX_RESULTS = 5;

/**
 * Home search over saved expressions AND the 단어장, using the same search
 * module as /vocabulary (accent/case-insensitive, ’ = ', lemma forms,
 * meanings, patterns, sentences). Data comes from the same cached query.
 */
export function HomeSearch() {
  const [query, setQuery] = useState('');
  const { entries, data } = useVocabularyData();

  const expressionIndex = useMemo(
    () => (data?.expressions ?? []).map((e) => ({ e, text: buildSearchText([e.expression_fr, e.meaning_ko]) })),
    [data]
  );

  const active = query.trim().length > 0;
  const lemmaHits = active ? filterAndSort(entries, { query, filter: 'all', sort: 'sentences' }).slice(0, MAX_RESULTS) : [];
  const exprHits = active ? expressionIndex.filter((x) => matchesSearch(x.text, query)).slice(0, MAX_RESULTS) : [];

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="표현·단어 검색 (mise → mettre, 뜻, 패턴)"
        className="w-full rounded-xl border border-slate-300 p-3 text-sm dark:border-slate-700 dark:bg-slate-900"
      />
      {active && (
        <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 p-3 text-sm dark:border-slate-800">
          {lemmaHits.length === 0 && exprHits.length === 0 && <p className="text-slate-400">검색 결과가 없습니다.</p>}
          {lemmaHits.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-slate-400">단어장</p>
              {lemmaHits.map((hit) => (
                <Link key={hit.lemma.id} to={`/vocabulary/${hit.lemma.id}`} className="block py-1">
                  <span className="font-medium">{hit.lemma.lemma}</span>
                  {hit.lemma.part_of_speech && <span className="ml-1 text-xs text-slate-400">{posLabel(hit.lemma.part_of_speech)}</span>}
                  {hit.representativeMeaning && <span className="text-slate-500"> — {hit.representativeMeaning}</span>}
                </Link>
              ))}
            </div>
          )}
          {exprHits.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-slate-400">표현장</p>
              {exprHits.map(({ e }) => (
                <Link key={e.id} to={`/expression/${e.id}`} className="block break-words py-1">
                  {e.expression_fr}
                  {e.meaning_ko && <span className="text-slate-500"> — {e.meaning_ko}</span>}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
