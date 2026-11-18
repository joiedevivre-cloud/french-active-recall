import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

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
  pronunciation_ko: string | null;
  pronunciation_note: string | null;
  grammar_notes: GrammarNotes;
}

interface UsageRow {
  id: string;
  label: string;
  meaning_en: string | null;
  pattern: string | null;
  sort_order: number;
  label_user_edited: boolean;
}

interface AnalysisRow {
  expression_id: string;
  usage_id: string | null;
  pronunciation_ko: string | null;
  pronunciation_liaison: string | null;
  grammar_points: { form: string; meaning: string; example: string }[];
  expressions: { expression_fr: string; meaning_ko: string | null } | null;
}

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
  const [editLabel, setEditLabel] = useState('');

  const { data: lemmas = [], isLoading: lemmasLoading } = useQuery({
    queryKey: ['vocabulary-lemmas', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('lemmas')
        .select('id, lemma, part_of_speech, pronunciation_ipa, pronunciation_ko, pronunciation_note, grammar_notes')
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

  const filteredLemmas = useMemo(
    () => lemmas.filter((l) => l.lemma.toLowerCase().includes(search.toLowerCase())),
    [lemmas, search]
  );

  const selectedLemma = lemmas.find((l) => l.id === selectedLemmaId) ?? null;

  const { data: usages = [] } = useQuery({
    queryKey: ['vocabulary-usages', selectedLemmaId],
    enabled: !!selectedLemmaId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('lemma_usages')
        .select('id, label, meaning_en, pattern, sort_order, label_user_edited')
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
        .select('expression_id, usage_id, pronunciation_ko, pronunciation_liaison, grammar_points, expressions(expression_fr, meaning_ko)')
        .eq('lemma_id', selectedLemmaId!);
      if (error) throw error;
      return data as unknown as AnalysisRow[];
    },
  });

  const invalidateLemmaDetail = () => {
    queryClient.invalidateQueries({ queryKey: ['vocabulary-usages', selectedLemmaId] });
    queryClient.invalidateQueries({ queryKey: ['vocabulary-analyses', selectedLemmaId] });
  };

  const saveLabel = useMutation({
    mutationFn: async (usageId: string) => {
      await supabase.from('lemma_usages').update({ label: editLabel, label_user_edited: true }).eq('id', usageId);
    },
    onSuccess: () => {
      setEditingUsageId(null);
      invalidateLemmaDetail();
    },
  });

  const reassignUsage = useMutation({
    mutationFn: async ({ expressionId, usageId }: { expressionId: string; usageId: string }) => {
      await supabase.from('expression_analysis').update({ usage_id: usageId, usage_user_assigned: true }).eq('expression_id', expressionId);
    },
    onSuccess: invalidateLemmaDetail,
  });

  const byUsage = useMemo(() => {
    const map = new Map<string | null, AnalysisRow[]>();
    for (const row of analyses) {
      const key = row.usage_id;
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return map;
  }, [analyses]);

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
            <p className="mt-1 text-sm text-slate-500">
              {selectedLemma.pronunciation_ipa} {selectedLemma.pronunciation_ko && `· ${selectedLemma.pronunciation_ko}`}
            </p>
            {selectedLemma.pronunciation_note && <p className="text-xs text-slate-400">{selectedLemma.pronunciation_note}</p>}
            {(selectedLemma.grammar_notes?.conjugation_present || selectedLemma.grammar_notes?.past_participle) && (
              <p className="mt-2 text-sm text-slate-500">
                {[selectedLemma.grammar_notes.conjugation_present, selectedLemma.grammar_notes.past_participle, selectedLemma.grammar_notes.auxiliary]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
            {(selectedLemma.grammar_notes?.common_mistakes?.length ?? 0) > 0 && (
              <ul className="mt-2 flex flex-col gap-1 text-xs text-amber-600">
                {selectedLemma.grammar_notes.common_mistakes!.map((m, i) => (
                  <li key={i}>⚠ {m}</li>
                ))}
              </ul>
            )}
          </div>

          {usages.map((usage) => (
            <section key={usage.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
              <div className="flex items-center justify-between">
                {editingUsageId === usage.id ? (
                  <div className="flex flex-1 items-center gap-2">
                    <input
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      className="flex-1 rounded-lg border border-slate-300 p-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                    />
                    <button onClick={() => saveLabel.mutate(usage.id)} className="text-xs text-blue-600">
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
                      setEditLabel(usage.label);
                    }}
                    className="text-sm font-bold"
                  >
                    {usage.label} ✎
                  </button>
                )}
              </div>
              {usage.pattern && <p className="mt-1 text-xs text-slate-400">{usage.pattern}</p>}

              <ul className="mt-3 flex flex-col gap-3">
                {(byUsage.get(usage.id) ?? []).map((row) => (
                  <li key={row.expression_id} className="text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <button onClick={() => speak(row.expressions?.expression_fr ?? '')} className="font-medium">
                          🔊 {row.expressions?.expression_fr}
                        </button>
                        <p className="text-slate-500">{row.expressions?.meaning_ko}</p>
                        {row.pronunciation_ko && <p className="text-xs text-slate-400">{row.pronunciation_ko}</p>}
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
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
