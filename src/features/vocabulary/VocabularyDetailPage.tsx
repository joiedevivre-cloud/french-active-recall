import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { seedLemmaDictionary } from '@/features/vocabulary/lemmaClient';
import { useVocabularyData, VOCABULARY_QUERY_KEY } from '@/features/vocabulary/useVocabularyData';
import { complementLabelFr, complementLabelKo, posLabel, registerLabel } from '@/lib/grammarTerms';
import { speakFrench, youglishUrl } from '@/lib/speech';

interface UsageDetail {
  id: string;
  label: string;
  meaning_ko: string | null;
  pattern: string | null;
  required_complement: string | null;
  mood_requirement: string | null;
  sort_order: number;
  source: 'dictionary' | 'learned';
  grammar_explanation_ko: string | null;
  common_mistakes_ko: string[];
  ai_example_sentences: { fr: string; ko: string }[];
  alternatives: { expression: string; meaning_ko: string; nuance_difference_ko: string; register: string }[];
  label_user_edited: boolean;
  user_edited_fields: string[];
}

interface SentenceAnalysisRow {
  expression_id: string;
  usage_id: string | null;
  usage_user_assigned: boolean;
  pronunciation_ipa: string | null;
  pronunciation_note: string | null;
  prompt_version: string | null;
  created_at: string;
}

interface GrammarNotes {
  conjugation_present?: string;
  past_participle?: string;
  auxiliary?: string | null;
  common_mistakes?: string[];
}

/**
 * /vocabulary/:lemmaId(?usage=:usageId) -- one lemma, accordion layout.
 * A/B/C open by default; D/E collapsed; F (문장 만들기 · 장기 복습) is
 * intentionally absent until stages 4-5. Shows only data that exists --
 * fields the word analysis (stage 2) will fill are labelled as such
 * instead of being faked.
 */
export default function VocabularyDetailPage() {
  const { lemmaId } = useParams<{ lemmaId: string }>();
  const [params] = useSearchParams();
  const focusUsageId = params.get('usage');
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { entries, data, isLoading } = useVocabularyData();
  const entry = entries.find((e) => e.lemma.id === lemmaId) ?? null;

  const { data: usageDetails = [] } = useQuery({
    queryKey: ['vocabulary-usage-details', lemmaId],
    enabled: !!lemmaId && !!user,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('lemma_usages')
        .select(
          'id, label, meaning_ko, pattern, required_complement, mood_requirement, sort_order, source, grammar_explanation_ko, common_mistakes_ko, ai_example_sentences, alternatives, label_user_edited, user_edited_fields'
        )
        .eq('lemma_id', lemmaId!)
        .order('sort_order');
      if (error) throw error;
      return rows as UsageDetail[];
    },
  });

  const { data: analyses = [] } = useQuery({
    queryKey: ['vocabulary-sentence-analyses', lemmaId],
    enabled: !!lemmaId && !!user,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('expression_analysis')
        .select('expression_id, usage_id, usage_user_assigned, pronunciation_ipa, pronunciation_note, prompt_version, created_at')
        .eq('lemma_id', lemmaId!);
      if (error) throw error;
      return rows as SentenceAnalysisRow[];
    },
  });

  const exprById = useMemo(() => new Map((data?.expressions ?? []).map((e) => [e.id, e])), [data]);
  const analysisByExpr = useMemo(() => new Map(analyses.map((a) => [a.expression_id, a])), [analyses]);
  const latestAnalysis = useMemo(
    () => [...analyses].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null,
    [analyses]
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [VOCABULARY_QUERY_KEY] });
    queryClient.invalidateQueries({ queryKey: ['vocabulary-usage-details', lemmaId] });
    queryClient.invalidateQueries({ queryKey: ['vocabulary-sentence-analyses', lemmaId] });
  };

  const [editing, setEditing] = useState<{ usageId: string; field: 'label' | 'meaning_ko'; value: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Same user-edit protection as before: label -> label_user_edited, other fields -> user_edited_fields.
  const saveField = useMutation({
    mutationFn: async ({ usageId, field, value }: { usageId: string; field: 'label' | 'meaning_ko'; value: string }) => {
      const usage = usageDetails.find((u) => u.id === usageId);
      const update =
        field === 'label'
          ? { label: value, label_user_edited: true }
          : { meaning_ko: value, user_edited_fields: [...new Set([...(usage?.user_edited_fields ?? []), 'meaning_ko'])] };
      const { error } = await supabase.from('lemma_usages').update(update).eq('id', usageId);
      if (error) throw error;
    },
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
  });

  // Moving a sentence marks the assignment as the user's -- re-analysis never moves it back.
  const reassign = useMutation({
    mutationFn: async ({ expressionId, usageId }: { expressionId: string; usageId: string }) => {
      const { error } = await supabase.from('expression_analysis').update({ usage_id: usageId, usage_user_assigned: true }).eq('expression_id', expressionId);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
  });

  const toggleFavorite = useMutation({
    mutationFn: async () => {
      if (!entry) return;
      const { error } = await supabase.from('lemmas').update({ is_favorite: !entry.isFavorite }).eq('id', entry.lemma.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
  });

  const seed = useMutation({
    mutationFn: async () => {
      const outcome = await seedLemmaDictionary(lemmaId!);
      if (outcome.status === 'failed') throw new Error(outcome.error ?? 'unknown_error');
    },
    onSettled: invalidate,
    onError: (err) => setActionError(`사전 쓰임 생성 실패: ${err instanceof Error ? err.message : String(err)}`),
  });

  useEffect(() => {
    if (!focusUsageId || usageDetails.length === 0) return;
    document.getElementById(`usage-${focusUsageId}`)?.scrollIntoView({ block: 'center' });
  }, [focusUsageId, usageDetails.length]);

  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/vocabulary');
  };

  if (isLoading) return <div className="p-5 text-sm text-slate-400">불러오는 중...</div>;
  if (!entry) {
    return (
      <div className="flex flex-col gap-3 p-5">
        <button onClick={goBack} className="self-start text-sm text-slate-400">← 단어장</button>
        <p className="text-sm text-slate-500">단어를 찾을 수 없습니다.</p>
      </div>
    );
  }

  const lemma = entry.lemma;
  const notes = (lemma.grammar_notes ?? {}) as GrammarNotes;
  const hasFavoriteColumn = 'is_favorite' in lemma;
  const basicMeanings = Array.isArray(lemma.basic_meanings_ko) ? lemma.basic_meanings_ko : null;
  const gatheredMeanings = [...new Set(usageDetails.map((u) => u.meaning_ko || u.label).filter(Boolean))];

  return (
    <div className="flex flex-col gap-3 p-4">
      <button onClick={goBack} className="self-start text-sm text-slate-400">← 단어장</button>

      {actionError && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950 dark:text-red-300">{actionError}</p>}

      {/* A. 상단 */}
      <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{lemma.lemma}</h1>
          {lemma.part_of_speech && <span className="text-sm text-slate-400">{posLabel(lemma.part_of_speech)}</span>}
          <button
            onClick={() => toggleFavorite.mutate()}
            disabled={!hasFavoriteColumn || toggleFavorite.isPending}
            title={hasFavoriteColumn ? undefined : '즐겨찾기는 DB 업데이트(0019) 후 사용할 수 있습니다'}
            className="ml-auto text-2xl disabled:opacity-30"
          >
            {entry.isFavorite ? '⭐' : '☆'}
          </button>
        </div>
        {lemma.pronunciation_ipa && <p className="mt-1 text-sm text-slate-500">{lemma.pronunciation_ipa}</p>}
        <div className="mt-2 flex flex-wrap gap-2 text-sm">
          <button onClick={() => speakFrench(lemma.lemma)} className="rounded-full border border-slate-300 px-3 py-1 dark:border-slate-700">
            🔊 듣기
          </button>
          <a href={youglishUrl(lemma.lemma)} target="_blank" rel="noopener noreferrer" className="rounded-full border border-slate-300 px-3 py-1 dark:border-slate-700">
            🎬 YouGlish
          </a>
        </div>
        <div className="mt-3 flex flex-col gap-1 text-xs text-slate-400">
          <p>
            단어 분석:{' '}
            {lemma.word_analysis_status === 'done' ? '완료' : lemma.word_analysis_status === 'failed' ? '실패' : '아직 없음'}
          </p>
          {latestAnalysis && (
            <p>
              최근 문장 분석: {latestAnalysis.prompt_version ?? '—'} · {new Date(latestAnalysis.created_at).toLocaleString('ko-KR')}
            </p>
          )}
        </div>
        <button disabled className="mt-3 w-full rounded-full border border-slate-300 py-2 text-sm opacity-50 dark:border-slate-700">
          단어 분석 다시 만들기 (준비 중)
        </button>
      </section>

      {/* B. 기본 의미 */}
      <Accordion title="기본 의미" defaultOpen>
        {basicMeanings && basicMeanings.length > 0 ? (
          <ol className="list-decimal pl-5 text-sm">
            {basicMeanings.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ol>
        ) : gatheredMeanings.length > 0 ? (
          <>
            <p className="text-sm">{gatheredMeanings.join(' · ')}</p>
            <p className="mt-1 text-xs text-slate-400">저장한 문장의 쓰임에서 모은 뜻입니다. 단어 분석을 하면 대표 의미가 정리됩니다.</p>
          </>
        ) : (
          <p className="text-sm text-slate-400">아직 의미 정보가 없습니다.</p>
        )}
      </Accordion>

      {/* C. 쓰임별 카드 */}
      <Accordion title={`쓰임 (${usageDetails.length})`} defaultOpen>
        <ul className="flex flex-col gap-2">
          {usageDetails.map((usage) => {
            const sentenceIds = entry.usages.find((u) => u.usage.id === usage.id)?.expressionIds ?? [];
            const focused = usage.id === focusUsageId;
            return (
              <li key={usage.id} id={`usage-${usage.id}`}>
                <details
                  open={focused}
                  className={`rounded-xl border p-3 ${focused ? 'border-blue-400 ring-2 ring-blue-200 dark:border-blue-600 dark:ring-blue-900' : 'border-slate-200 dark:border-slate-800'}`}
                >
                  <summary className="cursor-pointer list-none">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">
                          {usage.label}
                          {usage.source === 'dictionary' && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] font-normal text-slate-500 dark:bg-slate-800">사전</span>}
                        </p>
                        {usage.pattern && <p className="break-words text-sm italic text-slate-600 dark:text-slate-300">{usage.pattern}</p>}
                        {usage.meaning_ko && usage.meaning_ko !== usage.label && <p className="text-sm text-slate-500">{usage.meaning_ko}</p>}
                      </div>
                      <span className="whitespace-nowrap text-xs text-slate-400">문장 {sentenceIds.length} ▾</span>
                    </div>
                  </summary>

                  <div className="mt-3 flex flex-col gap-3 border-t border-slate-100 pt-3 text-sm dark:border-slate-800">
                    {complementLabelFr(usage.required_complement, usage.mood_requirement) && (
                      <p className="text-xs text-slate-400">
                        뒤에 오는 요소: {complementLabelFr(usage.required_complement, usage.mood_requirement)}
                        {complementLabelKo(usage.required_complement, usage.mood_requirement) && ` (${complementLabelKo(usage.required_complement, usage.mood_requirement)})`}
                      </p>
                    )}
                    {usage.grammar_explanation_ko && <p className="text-slate-600 dark:text-slate-300">{usage.grammar_explanation_ko}</p>}

                    {sentenceIds.length > 0 ? (
                      <ul className="flex flex-col gap-2">
                        {sentenceIds.map((id) => {
                          const expr = exprById.get(id);
                          const a = analysisByExpr.get(id);
                          if (!expr) return null;
                          return (
                            <li key={id} className="flex items-start gap-2">
                              <button onClick={() => speakFrench(expr.expression_fr)} className="shrink-0" aria-label="듣기">
                                🔊
                              </button>
                              <Link to={`/expression/${id}`} className="min-w-0 flex-1">
                                <p className="break-words font-medium">{expr.expression_fr}</p>
                                {expr.meaning_ko && <p className="text-xs text-slate-500">{expr.meaning_ko}</p>}
                                {a?.pronunciation_ipa && <p className="break-words text-xs text-slate-400">{a.pronunciation_ipa}</p>}
                              </Link>
                              {usageDetails.length > 1 && (
                                <select
                                  value={usage.id}
                                  onChange={(e) => reassign.mutate({ expressionId: id, usageId: e.target.value })}
                                  aria-label="다른 쓰임으로 옮기기"
                                  className="max-w-[7rem] shrink-0 rounded-lg border border-slate-300 bg-transparent p-1 text-xs dark:border-slate-700"
                                >
                                  {usageDetails.map((u) => (
                                    <option key={u.id} value={u.id}>
                                      {u.label}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="text-xs text-slate-400">이 쓰임으로 저장한 문장이 아직 없습니다.</p>
                    )}

                    {usage.ai_example_sentences.length > 0 && (
                      <ul className="flex flex-col gap-1">
                        {usage.ai_example_sentences.map((ex, i) => (
                          <li key={i} className="text-xs">
                            <span className="mr-1 rounded bg-slate-100 px-1 text-slate-500 dark:bg-slate-800">AI 예문</span>
                            <button onClick={() => speakFrench(ex.fr)} className="text-left">
                              🔊 {ex.fr}
                            </button>
                            <span className="text-slate-500"> — {ex.ko}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {usage.alternatives.length > 0 && (
                      <ul className="flex flex-col gap-1 text-xs">
                        {usage.alternatives.map((alt, i) => (
                          <li key={i}>
                            <span className="font-medium">{alt.expression}</span>
                            <span className="text-slate-500"> — {alt.meaning_ko}{alt.register ? ` (${registerLabel(alt.register)})` : ''}</span>
                            {alt.nuance_difference_ko && <span className="block text-slate-400">{alt.nuance_difference_ko}</span>}
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="flex flex-wrap gap-2 text-xs">
                      {editing?.usageId === usage.id ? (
                        <div className="flex w-full items-center gap-2">
                          <input
                            value={editing.value}
                            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                            className="min-w-0 flex-1 rounded-lg border border-slate-300 p-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                          />
                          <button onClick={() => saveField.mutate(editing)} className="text-blue-600">저장</button>
                          <button onClick={() => setEditing(null)} className="text-slate-400">취소</button>
                        </div>
                      ) : (
                        <>
                          <button onClick={() => setEditing({ usageId: usage.id, field: 'label', value: usage.label })} className="text-slate-500">
                            ✎ 라벨 수정{usage.label_user_edited ? ' (직접 수정함)' : ''}
                          </button>
                          <button
                            onClick={() => setEditing({ usageId: usage.id, field: 'meaning_ko', value: usage.meaning_ko ?? '' })}
                            className="text-slate-500"
                          >
                            ✎ 뜻 수정{usage.user_edited_fields.includes('meaning_ko') ? ' (직접 수정함)' : ''}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>

        {entry.unassignedExpressionIds.length > 0 && (
          <div className="mt-3 rounded-xl border border-dashed border-slate-300 p-3 text-sm dark:border-slate-700">
            <p className="text-xs text-slate-400">쓰임 미배정 문장</p>
            {entry.unassignedExpressionIds.map((id) => (
              <Link key={id} to={`/expression/${id}`} className="block break-words">
                {exprById.get(id)?.expression_fr}
              </Link>
            ))}
          </div>
        )}

        {!usageDetails.some((u) => u.source === 'dictionary') && (
          <button
            onClick={() => seed.mutate()}
            disabled={seed.isPending}
            className="mt-3 w-full rounded-full border border-slate-300 py-2 text-xs text-slate-500 disabled:opacity-40 dark:border-slate-700"
          >
            {seed.isPending ? '사전 쓰임 생성 중...' : '사전 쓰임 추가 (AI)'}
          </button>
        )}
      </Accordion>

      {/* D. 활용표 */}
      <Accordion title="활용">
        {notes.conjugation_present || notes.past_participle || notes.auxiliary ? (
          <dl className="flex flex-col gap-1 text-sm">
            {notes.conjugation_present && <Row label="présent" value={notes.conjugation_present} />}
            {notes.past_participle && <Row label="participe passé" value={notes.past_participle} />}
            {notes.auxiliary && <Row label="auxiliaire" value={notes.auxiliary} />}
          </dl>
        ) : (
          <p className="text-sm text-slate-400">활용 정보가 없습니다.</p>
        )}
        <p className="mt-2 text-xs text-slate-400">복합과거·반과거·미래·조건법·접속법 전체 활용표는 단어 분석(준비 중) 후 표시됩니다.</p>
      </Accordion>

      {/* E. 헷갈리는 표현 */}
      <Accordion title="헷갈리는 표현 · 학습 포인트">
        {(notes.common_mistakes?.length ?? 0) > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {notes.common_mistakes!.map((m, i) => (
              <li key={i}>💡 {m}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-400">아직 없습니다.</p>
        )}
        <p className="mt-2 text-xs text-slate-400">헷갈리는 표현 비교(예: mettre / allumer)는 단어 분석(준비 중) 후 표시됩니다.</p>
      </Accordion>

      {/* F. 문장 만들기 · 장기 복습: 4·5단계에서 추가 */}
    </div>
  );
}

function Accordion({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
      <summary className="cursor-pointer text-sm font-bold">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-slate-400">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}
