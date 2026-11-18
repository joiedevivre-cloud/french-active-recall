import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  analyzeDetailed,
  type SentenceStructure,
  type VocabularyItem,
  type CorePattern,
  type GrammarPoint,
  type StructureComponent,
} from '@/features/ai-batch/aiBatchClient';
import { applyAnalysisResult, markAnalyzing } from '@/features/ai-batch/applyAnalysisResult';
import { effectiveAnalysisState } from '@/features/ai-batch/staleAnalysis';
import { analyzeLemmaBatch } from '@/features/vocabulary/lemmaClient';
import {
  complementLabelFr,
  complementLabelKo,
  koGlossFor,
  posLabel,
  registerLabel,
  SENTENCE_STRUCTURE_LABELS,
  toFrenchTerm,
} from '@/lib/grammarTerms';

interface LemmaAnalysisData {
  lemma_id: string;
  usage_id: string;
  pronunciation_ipa: string | null;
  pronunciation_note: string | null;
  grammar_points: { form: string; meaning: string; example: string }[];
  lemmas: { lemma: string } | null;
  lemma_usages: { label: string } | null;
}

interface DetailedAnalysisData {
  core_pattern?: CorePattern | null; // absent on legacy detailed-v1 cached rows
  sentence_structure: SentenceStructure | null;
  structure_components?: StructureComponent[]; // v3 only
  grammar_points: GrammarPoint[]; // v3 fields optional -- legacy rows have pattern/meaning/example only
  vocabulary: VocabularyItem[];
  common_mistakes: string[];
  similar_expressions: { a: string; b: string; difference: string }[];
  example_sentences: { fr: string; ko: string }[];
}

interface ExpressionDetailRow {
  id: string;
  expression_fr: string;
  meaning_ko: string | null;
  corrected_fr: string | null;
  cefr_level: string | null;
  source_type: string;
  source_label: string | null;
  is_favorite: boolean;
  ai_analysis_status: string;
  analysis_requested_at: string | null;
  analyzed_at: string | null;
  detailed_analysis: DetailedAnalysisData | null;
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

export default function ExpressionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const { data: expr, isLoading } = useQuery({
    queryKey: ['expression-detail', id],
    enabled: !!user && !!id,
    refetchInterval: (query) =>
      query.state.data && effectiveAnalysisState(toAnalysisInput(query.state.data)) === 'analyzing' ? 3000 : false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('expressions')
        .select(
          'id, expression_fr, meaning_ko, corrected_fr, cefr_level, source_type, source_label, is_favorite, ai_analysis_status, analysis_requested_at, analyzed_at, detailed_analysis'
        )
        .eq('id', id!)
        .eq('user_id', user!.id)
        .single();
      if (error) throw error;
      return data as ExpressionDetailRow;
    },
  });

  function toAnalysisInput(e: ExpressionDetailRow) {
    return { aiAnalysisStatus: e.ai_analysis_status, analysisRequestedAt: e.analysis_requested_at, meaningKo: e.meaning_ko };
  }

  const { data: lemmaAnalysis, isLoading: lemmaLoading } = useQuery({
    queryKey: ['expression-lemma-analysis', id],
    enabled: !!user && !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('expression_analysis')
        .select('lemma_id, usage_id, pronunciation_ipa, pronunciation_note, grammar_points, lemmas(lemma), lemma_usages(label)')
        .eq('expression_id', id!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as LemmaAnalysisData | null;
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['expression-detail', id] });
    queryClient.invalidateQueries({ queryKey: ['expression-lemma-analysis', id] });
  };

  const runLemmaAnalysis = useMutation({
    mutationFn: async (force: boolean) => {
      if (!expr) return;
      await analyzeLemmaBatch([expr.id], force);
    },
    onSettled: invalidate,
  });

  const toggleFavorite = useMutation({
    mutationFn: async () => {
      if (!expr) return;
      await supabase.from('expressions').update({ is_favorite: !expr.is_favorite }).eq('id', expr.id);
    },
    onSuccess: invalidate,
  });

  const runDetailedAnalysis = useMutation({
    mutationFn: async () => {
      if (!expr) return;
      setAnalysisError(null);
      await markAnalyzing([expr.id]);
      invalidate();
      const result = await analyzeDetailed(expr.expression_fr);
      if (result.status === 'failed') {
        setAnalysisError(result.error ?? 'unknown_error');
        await applyAnalysisResult(expr.id, null);
        return;
      }
      await applyAnalysisResult(expr.id, result.result ?? null);
    },
    onSettled: invalidate,
  });

  if (isLoading || !expr) {
    return <div className="p-5 text-sm text-slate-400">불러오는 중...</div>;
  }

  const state = effectiveAnalysisState(toAnalysisInput(expr));
  const analysis = expr.detailed_analysis;

  return (
    <div className="flex flex-col gap-4 p-5">
      <button onClick={() => navigate(-1)} className="text-sm text-slate-400">
        ← 뒤로
      </button>

      {/* A. 기본 정보 */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xl font-semibold">{expr.expression_fr}</p>
          <p className="mt-1 text-base text-slate-500">{expr.meaning_ko ?? '뜻 없음'}</p>
        </div>
        <button onClick={() => toggleFavorite.mutate()} className="text-2xl">
          {expr.is_favorite ? '⭐' : '☆'}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={() => speak(expr.expression_fr)} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
          🔊 발음 듣기
        </button>
        {expr.cefr_level && (
          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-500 dark:bg-slate-800">
            CEFR {expr.cefr_level} (AI 추정치)
          </span>
        )}
      </div>

      <p className="text-xs text-slate-400">
        출처: {expr.source_label ?? expr.source_type} · 마지막 AI 분석: {expr.analyzed_at ? new Date(expr.analyzed_at).toLocaleString('ko-KR') : '없음'}
      </p>

      {/* 단어장: 발음 + 쓰임 + 문법 설명 (detailed_analysis와는 완전히 별도 테이블/캐시) */}
      <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
        {lemmaLoading && <p className="text-sm text-slate-400">단어 분석 불러오는 중...</p>}
        {!lemmaLoading && !lemmaAnalysis && (
          <button
            onClick={() => runLemmaAnalysis.mutate(false)}
            disabled={runLemmaAnalysis.isPending}
            className="w-full rounded-full border border-slate-300 py-2 text-sm disabled:opacity-40 dark:border-slate-700"
          >
            {runLemmaAnalysis.isPending ? '분석 중...' : '단어 분석 만들기'}
          </button>
        )}
        {lemmaAnalysis && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <button
                onClick={() => navigate(`/vocabulary?lemma=${lemmaAnalysis.lemma_id}`)}
                className="rounded-full bg-slate-100 px-3 py-1 text-sm dark:bg-slate-800"
              >
                쓰임: {lemmaAnalysis.lemmas?.lemma} – {lemmaAnalysis.lemma_usages?.label}
              </button>
              <button
                onClick={() => runLemmaAnalysis.mutate(true)}
                disabled={runLemmaAnalysis.isPending}
                className="text-xs text-slate-400 disabled:opacity-40"
              >
                {runLemmaAnalysis.isPending ? '재생성 중...' : '다시 생성'}
              </button>
            </div>
            {lemmaAnalysis.pronunciation_ipa && <p className="text-sm text-slate-500">{lemmaAnalysis.pronunciation_ipa}</p>}
            {lemmaAnalysis.pronunciation_note && <p className="text-xs text-slate-400">{lemmaAnalysis.pronunciation_note}</p>}
            {lemmaAnalysis.grammar_points.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-sm font-medium">문법 설명 ▾</summary>
                <ul className="mt-2 flex flex-col gap-2">
                  {lemmaAnalysis.grammar_points.map((gp, i) => (
                    <li key={i} className="text-sm">
                      <p className="font-medium">{gp.form}</p>
                      <p className="text-slate-500">{gp.meaning}</p>
                      <p className="italic text-slate-400">{gp.example}</p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>

      {/* AI 다시 분석 */}
      <div>
        <button
          onClick={() => runDetailedAnalysis.mutate()}
          disabled={runDetailedAnalysis.isPending || state === 'analyzing'}
          className="w-full rounded-full bg-blue-600 py-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          {state === 'analyzing' ? 'AI 분석 중...' : analysis ? 'AI 다시 분석' : '상세 분석 만들기'}
        </button>
        {state === 'stalled' && <p className="mt-1 text-xs text-amber-600">이전 요청이 응답 없이 멈췄습니다. 다시 눌러주세요.</p>}
        {analysisError && <p className="mt-1 text-xs text-red-500">분석 실패: {analysisError}</p>}
      </div>

      {!analysis && (
        <p className="text-sm text-slate-400">아직 상세 분석이 없습니다. 위 버튼을 눌러 생성하세요 (원문은 이미 확인 가능합니다).</p>
      )}

      {analysis && (
        <>
          {/* 실제 문장 오류: corrected_fr가 있을 때만 -- 올바른 문장에는 오류 경고를 절대 표시하지 않음 */}
          {expr.corrected_fr && expr.corrected_fr.trim() !== expr.expression_fr.trim() && (
            <section className="rounded-2xl border border-red-200 p-4 dark:border-red-900">
              <h2 className="mb-1 text-sm font-bold text-red-600 dark:text-red-400">이 문장의 오류</h2>
              <p className="text-sm">
                올바른 형태: <span className="font-medium">{expr.corrected_fr}</span>
              </p>
            </section>
          )}

          {/* 핵심 패턴 (v2): 숙어/준조동사 구문(se mettre à + infinitif 등) 인식 -- 문장 구조보다 먼저 */}
          {analysis.core_pattern && (
            <section className="rounded-2xl border border-blue-200 p-4 dark:border-blue-800">
              <h2 className="mb-2 text-sm font-bold">핵심 패턴</h2>
              <p className="text-xs text-slate-400">Construction grammaticale</p>
              <p className="font-medium italic">
                {analysis.core_pattern.pattern} <span className="text-sm not-italic text-slate-500">— {analysis.core_pattern.meaning_ko}</span>
              </p>
              <p className="mt-1 text-sm text-slate-500">문장 속 형태: {analysis.core_pattern.matched_form}</p>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{analysis.core_pattern.explanation_ko}</p>
            </section>
          )}

          {/* B. 문장 구조 */}
          {((analysis.structure_components?.length ?? 0) > 0 || analysis.sentence_structure) && (
            <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
              <h2 className="mb-2 text-sm font-bold">문장 구조</h2>
              {(analysis.structure_components?.length ?? 0) > 0 && (
                <ul className="flex flex-col gap-2">
                  {analysis.structure_components!.map((c, i) => (
                    <li key={i} className="text-sm">
                      <p>
                        <span className="font-medium">{c.text}</span>{' '}
                        <span className="text-xs text-blue-600 dark:text-blue-400">{c.function_fr}</span>
                        {koGlossFor(c.function_fr) && <span className="text-xs text-slate-400"> ({koGlossFor(c.function_fr)})</span>}
                      </p>
                      <p className="text-slate-500">{c.note_ko}</p>
                    </li>
                  ))}
                </ul>
              )}
              {analysis.sentence_structure && (
                <>
                  <dl
                    className={`flex flex-col gap-1 text-sm ${
                      (analysis.structure_components?.length ?? 0) > 0 ? 'mt-3 border-t border-slate-100 pt-3 dark:border-slate-800' : ''
                    }`}
                  >
                    {(Object.keys(SENTENCE_STRUCTURE_LABELS) as (keyof typeof SENTENCE_STRUCTURE_LABELS)[]).map((key) => (
                      <Row
                        key={key}
                        label={SENTENCE_STRUCTURE_LABELS[key].fr}
                        gloss={SENTENCE_STRUCTURE_LABELS[key].ko}
                        value={analysis.sentence_structure![key]}
                      />
                    ))}
                  </dl>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{analysis.sentence_structure.mood_explanation}</p>
                  {analysis.sentence_structure.mood_contrast && (
                    <p className="mt-1 text-sm text-slate-500">{analysis.sentence_structure.mood_contrast}</p>
                  )}
                  <p className="mt-2 text-sm italic text-slate-500">{analysis.sentence_structure.overall_meaning}</p>
                </>
              )}
            </section>
          )}

          {/* 핵심 문법: Construction grammaticale 카드 + 대체 표현 + 문장 만들기 */}
          {analysis.grammar_points.length > 0 && (
            <details className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800" open>
              <summary className="text-sm font-bold">핵심 문법</summary>
              <ul className="mt-2 flex flex-col gap-4">
                {analysis.grammar_points.map((gp, i) => (
                  <GrammarPointCard
                    key={i}
                    gp={gp}
                    onPractice={() => navigate(`/expression/${expr.id}/practice?pattern=${encodeURIComponent(gp.pattern)}`)}
                  />
                ))}
              </ul>
            </details>
          )}

          {/* D. 단어별 설명 -- 실제 오류(sentence_error)와 학습 포인트를 구분 */}
          {analysis.vocabulary.length > 0 && (
            <details className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
              <summary className="text-sm font-bold">단어별 설명</summary>
              <ul className="mt-2 flex flex-col gap-3">
                {analysis.vocabulary.map((v, i) => {
                  const learningPoint = v.learning_point ?? v.common_mistake ?? null;
                  return (
                    <li key={i}>
                      <p className="font-medium">
                        {v.word} <span className="text-xs text-slate-400">({posLabel(v.part_of_speech)})</span>
                      </p>
                      <p className="text-sm text-slate-500">{v.meaning_ko}</p>
                      <p className="text-xs text-slate-400">
                        {[v.infinitive, v.tense_or_conjugation && toFrenchTerm(v.tense_or_conjugation), v.gender_agreement, v.preposition]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      {v.sentence_error && <p className="text-xs text-red-500">⚠ 이 문장의 오류: {v.sentence_error}</p>}
                      {learningPoint && <p className="text-xs text-slate-500">💡 학습 포인트: {learningPoint}</p>}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          {/* 학습자가 자주 하는 실수 = 일반 학습 포인트 (이 문장이 틀렸다는 뜻이 아님) */}
          {analysis.common_mistakes.length > 0 && (
            <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
              <h2 className="mb-2 text-sm font-bold">💡 학습 포인트</h2>
              <ul className="flex flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">
                {analysis.common_mistakes.map((m, i) => (
                  <li key={i}>• {m}</li>
                ))}
              </ul>
            </section>
          )}

          {/* E. 비슷한 표현 */}
          {analysis.similar_expressions.length > 0 && (
            <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
              <h2 className="mb-2 text-sm font-bold">헷갈리는 표현</h2>
              <ul className="flex flex-col gap-2">
                {analysis.similar_expressions.map((s, i) => (
                  <li key={i} className="text-sm">
                    <span className="font-medium">
                      {s.a} / {s.b}
                    </span>
                    <p className="text-slate-500">{s.difference}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* F. 응용 예문 */}
          {analysis.example_sentences.length > 0 && (
            <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
              <h2 className="mb-2 text-sm font-bold">응용 예문</h2>
              <ul className="flex flex-col gap-2">
                {analysis.example_sentences.map((ex, i) => (
                  <li key={i} className="text-sm">
                    <button onClick={() => speak(ex.fr)} className="font-medium">
                      🔊 {ex.fr}
                    </button>
                    <p className="text-slate-500">{ex.ko}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Row({ label, gloss, value }: { label: string; gloss?: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-slate-400">
        {label}
        {gloss && <span className="block text-[10px] leading-tight">{gloss}</span>}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * One "Construction grammaticale" card. Every v3 field is optional, so a
 * legacy (detailed-v1/v2) grammar point -- pattern/meaning/example only --
 * renders as before, just without the new rows.
 */
function GrammarPointCard({ gp, onPractice }: { gp: GrammarPoint; onPractice: () => void }) {
  const complementFr = complementLabelFr(gp.required_complement, gp.mood_requirement);
  const complementKo = complementLabelKo(gp.required_complement, gp.mood_requirement);
  const alternatives = gp.alternatives ?? [];
  return (
    <li className="flex flex-col gap-1">
      <p className="text-xs text-slate-400">Construction grammaticale</p>
      <p className="font-medium italic">
        {gp.pattern}
        {gp.meaning_ko && <span className="text-sm not-italic text-slate-500"> — {gp.meaning_ko}</span>}
      </p>

      {(complementFr || gp.preposition_rule || gp.form_in_sentence) && (
        <dl className="mt-1 flex flex-col gap-0.5 text-sm">
          {complementFr && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-slate-400">뒤에 오는 요소</dt>
              <dd>
                {complementFr}
                {complementKo && <span className="text-xs text-slate-400"> ({complementKo})</span>}
              </dd>
            </div>
          )}
          {gp.preposition_rule && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-slate-400">Préposition</dt>
              <dd>{gp.preposition_rule}</dd>
            </div>
          )}
          {gp.form_in_sentence && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-slate-400">문장 속 형태</dt>
              <dd>{gp.form_in_sentence}</dd>
            </div>
          )}
        </dl>
      )}

      <p className="text-sm text-slate-500">{gp.meaning}</p>
      {gp.example && <p className="text-sm italic text-green-700 dark:text-green-400">✓ {gp.example}</p>}
      {gp.incorrect_example && (
        <p className="text-sm">
          <span className="italic text-red-500 line-through decoration-1">✗ {gp.incorrect_example.fr}</span>
          <span className="block text-xs text-slate-500">{gp.incorrect_example.reason_ko}</span>
        </p>
      )}
      {(gp.learning_tips ?? []).map((tip, i) => (
        <p key={i} className="text-xs text-slate-500">
          💡 {tip}
        </p>
      ))}

      {alternatives.length > 0 && (
        <details className="mt-1 rounded-xl bg-slate-50 p-3 dark:bg-slate-900">
          <summary className="cursor-pointer text-sm font-medium">비슷한 표현 / 대체 표현 ({alternatives.length})</summary>
          <ul className="mt-2 flex flex-col gap-3">
            {alternatives.map((alt, i) => {
              const altComplementFr = complementLabelFr(alt.required_complement, alt.mood_requirement);
              return (
                <li key={i} className="text-sm">
                  <p>
                    <span className="font-medium italic">{alt.construction || alt.expression}</span>
                    {registerLabel(alt.register) && <span className="ml-1 text-xs text-slate-400">· {registerLabel(alt.register)}</span>}
                  </p>
                  <p className="text-slate-500">
                    {alt.meaning_ko}
                    {altComplementFr && <span className="text-xs text-slate-400"> · 뒤에: {altComplementFr}</span>}
                  </p>
                  <button onClick={() => speak(alt.rewritten_sentence)} className="mt-0.5 text-left italic">
                    🔊 {alt.rewritten_sentence}
                  </button>
                  <p className="text-xs text-slate-500">{alt.nuance_ko}</p>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      <button
        onClick={onPractice}
        className="mt-1 self-start rounded-full border border-blue-300 px-3 py-1 text-xs text-blue-600 dark:border-blue-800 dark:text-blue-400"
      >
        ✍️ 이 문법으로 문장 만들기
      </button>
    </li>
  );
}
