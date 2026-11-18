import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { seedLemmaDictionary } from '@/features/vocabulary/lemmaClient';

interface GrammarNotes {
  conjugation_present?: string;
  past_participle?: string;
  auxiliary?: string | null;
  common_mistakes?: string[];
}

interface LemmaRow {
  id: string;
  lemma: string;
  part_of_speech: string | null;
  pronunciation_ipa: string | null;
  grammar_notes: GrammarNotes;
}

interface UsageRow {
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
  alternatives: { expression: string; meaning_ko: string; nuance_difference_ko: string; register: string; example: string }[];
  label_user_edited: boolean;
  user_edited_fields: string[];
}

interface AnalysisRow {
  expression_id: string;
  usage_id: string | null;
  pronunciation_ipa: string | null;
  pronunciation_note: string | null;
  expressions: { expression_fr: string; meaning_ko: string | null } | null;
}

interface UsageReviewStateRow {
  lemma_usage_id: string;
  due_at: string;
}

type Filter = 'all' | 'learned' | 'unlearned' | 'due';

function speak(text: string) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const frCa = voices.find((v) => v.lang === 'fr-CA');
  const frAny = voices.find((v) => v.lang.startsWith('fr'));
  utterance.voice = frCa ?? frAny ?? null;
  utterance.lang = (frCa ?? frAny)?.lang ?? 'fr-FR';
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export default function VocabularyPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selectedLemmaId = params.get('lemma');
  const [search, setSearch] = useState('');
  const [editingUsageId, setEditingUsageId] = useState<string | null>(null);
  const [editField, setEditField] = useState<'label' | 'meaning_ko' | null>(null);
  const [editValue, setEditValue] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [seedError, setSeedError] = useState<string | null>(null);

  const { data: lemmas = [], isLoading: lemmasLoading } = useQuery({
    queryKey: ['vocabulary-lemmas', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('lemmas')
        .select('id, lemma, part_of_speech, pronunciation_ipa, grammar_notes')
        .eq('user_id', user!.id)
        .order('lemma');
      if (error) throw error;
      return data as LemmaRow[];
    },
  });

  const { data: counts = {} } = useQuery({
    queryKey: ['vocabulary-counts', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.from('expression_analysis').select('lemma_id').eq('user_id', user!.id);
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const row of data as { lemma_id: string | null }[]) {
        if (!row.lemma_id) continue;
        map[row.lemma_id] = (map[row.lemma_id] ?? 0) + 1;
      }
      return map;
    },
  });

  const filteredLemmas = useMemo(() => lemmas.filter((l) => l.lemma.toLowerCase().includes(search.toLowerCase())), [lemmas, search]);
  const selectedLemma = lemmas.find((l) => l.id === selectedLemmaId) ?? null;

  const { data: usages = [] } = useQuery({
    queryKey: ['vocabulary-usages', selectedLemmaId],
    enabled: !!selectedLemmaId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('lemma_usages')
        .select(
          'id, label, meaning_ko, pattern, required_complement, mood_requirement, sort_order, source, grammar_explanation_ko, common_mistakes_ko, ai_example_sentences, alternatives, label_user_edited, user_edited_fields'
        )
        .eq('lemma_id', selectedLemmaId!)
        .order('sort_order');
      if (error) throw error;
      return data as UsageRow[];
    },
  });

  const { data: analyses = [] } = useQuery({
    queryKey: ['vocabulary-analyses', selectedLemmaId],
    enabled: !!selectedLemmaId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('expression_analysis')
        .select('expression_id, usage_id, pronunciation_ipa, pronunciation_note, expressions(expression_fr, meaning_ko)')
        .eq('lemma_id', selectedLemmaId!);
      if (error) throw error;
      return data as unknown as AnalysisRow[];
    },
  });

  const { data: usageReviewStates = [] } = useQuery({
    queryKey: ['vocabulary-usage-review-states', selectedLemmaId, usages.map((u) => u.id).join(',')],
    enabled: !!selectedLemmaId && usages.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('review_states')
        .select('lemma_usage_id, due_at')
        .in('lemma_usage_id', usages.map((u) => u.id));
      if (error) throw error;
      return (data ?? []) as UsageReviewStateRow[];
    },
  });

  const invalidateLemmaDetail = () => {
    queryClient.invalidateQueries({ queryKey: ['vocabulary-usages', selectedLemmaId] });
    queryClient.invalidateQueries({ queryKey: ['vocabulary-analyses', selectedLemmaId] });
    queryClient.invalidateQueries({ queryKey: ['vocabulary-usage-review-states'] });
  };

  const saveField = useMutation({
    mutationFn: async ({ usageId, field, value }: { usageId: string; field: 'label' | 'meaning_ko'; value: string }) => {
      const usage = usages.find((u) => u.id === usageId);
      const update: Record<string, unknown> =
        field === 'label' ? { label: value, label_user_edited: true } : { meaning_ko: value, user_edited_fields: [...new Set([...(usage?.user_edited_fields ?? []), 'meaning_ko'])] };
      await supabase.from('lemma_usages').update(update).eq('id', usageId);
    },
    onSuccess: () => {
      setEditingUsageId(null);
      setEditField(null);
      invalidateLemmaDetail();
    },
  });

  const reassignUsage = useMutation({
    mutationFn: async ({ expressionId, usageId }: { expressionId: string; usageId: string }) => {
      await supabase.from('expression_analysis').update({ usage_id: usageId, usage_user_assigned: true }).eq('expression_id', expressionId);
    },
    onSuccess: invalidateLemmaDetail,
  });

  const startLearningUsage = useMutation({
    mutationFn: async (usageId: string) => {
      await supabase.from('review_states').upsert({ user_id: user!.id, lemma_usage_id: usageId }, { onConflict: 'user_id,lemma_usage_id', ignoreDuplicates: true });
    },
    onSuccess: invalidateLemmaDetail,
  });

  const seedDictionary = useMutation({
    mutationFn: async () => {
      if (!selectedLemma) return;
      setSeedError(null);
      const outcome = await seedLemmaDictionary(selectedLemma.id);
      if (outcome.status === 'failed') setSeedError(outcome.error ?? 'unknown_error');
    },
    onSettled: invalidateLemmaDetail,
  });

  const byUsage = useMemo(() => {
    const map = new Map<string | null, AnalysisRow[]>();
    for (const row of analyses) map.set(row.usage_id, [...(map.get(row.usage_id) ?? []), row]);
    return map;
  }, [analyses]);

  const dueUsageIds = useMemo(() => {
    const now = Date.now();
    return new Set(usageReviewStates.filter((r) => new Date(r.due_at).getTime() <= now).map((r) => r.lemma_usage_id));
  }, [usageReviewStates]);

  const learnedUsageIds = useMemo(() => new Set(analyses.filter((a) => a.usage_id).map((a) => a.usage_id!)), [analyses]);

  const visibleUsages = useMemo(() => {
    if (filter === 'learned') return usages.filter((u) => learnedUsageIds.has(u.id));
    if (filter === 'unlearned') return usages.filter((u) => !learnedUsageIds.has(u.id));
    if (filter === 'due') return usages.filter((u) => dueUsageIds.has(u.id));
    return usages;
  }, [usages, filter, learnedUsageIds, dueUsageIds]);

  const hasDictionaryUsages = usages.some((u) => u.source === 'dictionary');

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">단어별 보기</h1>
        <button onClick={() => navigate('/library')} className="text-sm text-slate-400">
          표현장으로 ←
        </button>
      </div>

      {!selectedLemma && (
        <>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="단어 검색..."
            className="w-full rounded-xl border border-slate-300 p-3 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          {lemmasLoading && <p className="text-sm text-slate-400">불러오는 중...</p>}
          {!lemmasLoading && filteredLemmas.length === 0 && (
            <p className="text-sm text-slate-400">아직 단어별 분석이 없습니다. 표현을 저장하면 자동으로 생성됩니다.</p>
          )}
          <ul className="flex flex-col gap-2">
            {filteredLemmas.map((l) => (
              <li key={l.id}>
                <button
                  onClick={() => setParams({ lemma: l.id })}
                  className="flex w-full items-center justify-between rounded-xl border border-slate-200 p-3 text-left dark:border-slate-800"
                >
                  <span>
                    <span className="font-medium">{l.lemma}</span>
                    {l.part_of_speech && <span className="ml-2 text-xs text-slate-400">({l.part_of_speech})</span>}
                  </span>
                  <span className="text-xs text-slate-400">{counts[l.id] ?? 0}개 문장</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {selectedLemma && (
        <div className="flex flex-col gap-4">
          <button onClick={() => setParams({})} className="text-sm text-slate-400">
            ← 단어 목록
          </button>

          <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <p className="text-xl font-semibold">{selectedLemma.lemma}</p>
              {selectedLemma.part_of_speech && <span className="text-xs text-slate-400">({selectedLemma.part_of_speech})</span>}
              <button onClick={() => speak(selectedLemma.lemma)} className="text-sm">
                🔊
              </button>
            </div>
            {selectedLemma.pronunciation_ipa && <p className="mt-1 text-sm text-slate-500">{selectedLemma.pronunciation_ipa}</p>}
            {(selectedLemma.grammar_notes?.conjugation_present || selectedLemma.grammar_notes?.past_participle) && (
              <p className="mt-2 text-sm text-slate-500">
                {[selectedLemma.grammar_notes.conjugation_present, selectedLemma.grammar_notes.past_participle, selectedLemma.grammar_notes.auxiliary].filter(Boolean).join(' · ')}
              </p>
            )}
            {(selectedLemma.grammar_notes?.common_mistakes?.length ?? 0) > 0 && (
              <ul className="mt-2 flex flex-col gap-1 text-xs text-amber-600">
                {selectedLemma.grammar_notes.common_mistakes!.map((m, i) => (
                  <li key={i}>⚠ {m}</li>
                ))}
              </ul>
            )}
            {!hasDictionaryUsages && (
              <div className="mt-3">
                <button
                  onClick={() => seedDictionary.mutate()}
                  disabled={seedDictionary.isPending}
                  className="w-full rounded-full border border-slate-300 py-2 text-sm disabled:opacity-40 dark:border-slate-700"
                >
                  {seedDictionary.isPending ? '사전 의미 생성 중...' : '사전 의미 보기'}
                </button>
                {seedError && <p className="mt-1 text-xs text-red-500">생성 실패: {seedError}</p>}
              </div>
            )}
          </div>

          <div className="flex gap-2 overflow-x-auto text-xs">
            {([
              ['all', `전체 주요 쓰임 (${usages.length})`],
              ['learned', `학습한 쓰임 (${usages.filter((u) => learnedUsageIds.has(u.id)).length})`],
              ['unlearned', `아직 학습 안 함 (${usages.filter((u) => !learnedUsageIds.has(u.id)).length})`],
              ['due', `복습 필요 (${usages.filter((u) => dueUsageIds.has(u.id)).length})`],
            ] as [Filter, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 ${filter === key ? 'bg-blue-600 text-white' : 'border border-slate-300 dark:border-slate-700'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {visibleUsages.map((usage) => (
            <section key={usage.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
              <div className="flex items-center justify-between gap-2">
                {editingUsageId === usage.id && editField === 'label' ? (
                  <div className="flex flex-1 items-center gap-2">
                    <input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="flex-1 rounded-lg border border-slate-300 p-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                    />
                    <button onClick={() => saveField.mutate({ usageId: usage.id, field: 'label', value: editValue })} className="text-xs text-blue-600">
                      저장
                    </button>
                    <button onClick={() => setEditingUsageId(null)} className="text-xs text-slate-400">
                      취소
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setEditingUsageId(usage.id);
                      setEditField('label');
                      setEditValue(usage.label);
                    }}
                    className="text-sm font-bold"
                  >
                    {usage.label} ✎
                  </button>
                )}
                <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${usage.source === 'dictionary' ? 'bg-slate-100 text-slate-500 dark:bg-slate-800' : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'}`}>
                  {usage.source === 'dictionary' ? '사전' : '학습함'}
                </span>
              </div>

              {usage.pattern && (
                <p className="mt-1 text-sm font-medium text-slate-600 dark:text-slate-300">
                  Construction grammaticale: <span className="italic">{usage.pattern}</span>
                </p>
              )}

              {editingUsageId === usage.id && editField === 'meaning_ko' ? (
                <div className="mt-1 flex items-center gap-2">
                  <input
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="flex-1 rounded-lg border border-slate-300 p-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                  />
                  <button onClick={() => saveField.mutate({ usageId: usage.id, field: 'meaning_ko', value: editValue })} className="text-xs text-blue-600">
                    저장
                  </button>
                  <button onClick={() => setEditingUsageId(null)} className="text-xs text-slate-400">
                    취소
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setEditingUsageId(usage.id);
                    setEditField('meaning_ko');
                    setEditValue(usage.meaning_ko ?? '');
                  }}
                  className="mt-1 text-sm text-slate-500"
                >
                  {usage.meaning_ko ?? '뜻 없음'} ✎
                </button>
              )}

              {usage.grammar_explanation_ko && <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{usage.grammar_explanation_ko}</p>}

              {usage.common_mistakes_ko.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 text-xs text-slate-500">
                  {usage.common_mistakes_ko.map((m, i) => (
                    <li key={i}>💡 학습 포인트: {m}</li>
                  ))}
                </ul>
              )}

              {usage.alternatives.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-slate-500">유사·대체 표현 ▾</summary>
                  <ul className="mt-1 flex flex-col gap-2">
                    {usage.alternatives.map((alt, i) => (
                      <li key={i} className="text-xs">
                        <p className="font-medium">{alt.expression}</p>
                        <p className="text-slate-500">
                          {alt.meaning_ko} ({alt.register})
                        </p>
                        <p className="text-slate-400">{alt.nuance_difference_ko}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {usage.ai_example_sentences.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {usage.ai_example_sentences.map((ex, i) => (
                    <li key={i} className="text-xs">
                      <span className="mr-1 rounded bg-slate-100 px-1 text-slate-400 dark:bg-slate-800">AI 생성</span>
                      <button onClick={() => speak(ex.fr)}>🔊 {ex.fr}</button>
                      <span className="text-slate-500"> — {ex.ko}</span>
                    </li>
                  ))}
                </ul>
              )}

              {!learnedUsageIds.has(usage.id) && (
                <button onClick={() => startLearningUsage.mutate(usage.id)} disabled={startLearningUsage.isPending} className="mt-3 rounded-full border border-blue-300 px-3 py-1 text-xs text-blue-600 dark:border-blue-800">
                  학습하기 (복습 큐에 추가)
                </button>
              )}

              {(byUsage.get(usage.id) ?? []).length > 0 && (
                <ul className="mt-3 flex flex-col gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                  {(byUsage.get(usage.id) ?? []).map((row) => (
                    <li key={row.expression_id} className="text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <button onClick={() => speak(row.expressions?.expression_fr ?? '')} className="font-medium">
                            🔊 {row.expressions?.expression_fr}
                          </button>
                          <p className="text-slate-500">{row.expressions?.meaning_ko}</p>
                          {row.pronunciation_ipa && <p className="text-xs text-slate-400">{row.pronunciation_ipa}</p>}
                          {row.pronunciation_note && <p className="text-xs text-slate-400">{row.pronunciation_note}</p>}
                        </div>
                        <select
                          value={usage.id}
                          onChange={(e) => reassignUsage.mutate({ expressionId: row.expression_id, usageId: e.target.value })}
                          className="rounded-lg border border-slate-300 bg-transparent p-1 text-xs dark:border-slate-700"
                        >
                          {usages.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
