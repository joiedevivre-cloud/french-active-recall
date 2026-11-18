import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { parsePasteText, markPasteDuplicates, type PasteParsedRow } from '@/lib/pasteParser';
import type { ExistingExpressionLookup } from '@/lib/csvImport';
import { analyzeSentencesInChunks, type AiBatchChunkResult, type BatchItemResult } from '@/features/ai-batch/aiBatchClient';
import { savePasteBatch, type SaveBatchRowInput } from '@/features/paste-save/pasteSave';

type RowStatus = 'duplicate' | 'needs_review' | 'analyzing' | 'success' | 'failed';

interface BatchRow {
  key: string;
  expressionFr: string;
  originalRow: PasteParsedRow;
  status: RowStatus;
  analysis?: BatchItemResult;
  error?: string;
  applyCorrection: boolean;
  checked: boolean;
  existingMeaningKo?: string | null;
}

const DEBOUNCE_MS = 1000;

export default function AiBatchAddPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [saveSummary, setSaveSummary] = useState<{ saved: number; offline: number } | null>(null);

  const isAnalyzingRef = useRef(false);
  const lastAnalyzedRef = useRef('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!text.trim()) return;
    debounceRef.current = setTimeout(() => void runAnalysis(), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  async function runAnalysis() {
    if (!user || isAnalyzingRef.current) return; // never overlap two analysis runs
    if (text === lastAnalyzedRef.current) return; // nothing changed since last run
    isAnalyzingRef.current = true;
    lastAnalyzedRef.current = text;

    const { rows: parsed } = parsePasteText(text);

    let existing: ExistingExpressionLookup[] = [];
    if (navigator.onLine) {
      const { data } = await supabase
        .from('expressions')
        .select('id, expression_fr, meaning_ko')
        .eq('user_id', user.id)
        .is('deleted_at', null);
      existing = data ?? [];
    }

    const marked = markPasteDuplicates(parsed, existing);
    const nextRows: BatchRow[] = marked.map((row) => ({
      key: `${row.lineNumber}:${row.expressionFr}`,
      expressionFr: row.expressionFr,
      originalRow: row,
      status: row.status === 'duplicate' ? 'duplicate' : row.status === 'needs_review' ? 'needs_review' : 'analyzing',
      applyCorrection: false,
      checked: true,
      existingMeaningKo: row.existingMeaningKo,
    }));
    setRows(nextRows);

    const toAnalyze = nextRows.filter((r) => r.status === 'analyzing');
    if (toAnalyze.length === 0) {
      isAnalyzingRef.current = false;
      return;
    }

    setProgress({ done: 0, total: toAnalyze.length });
    const chunkResults = await analyzeSentencesInChunks(
      toAnalyze.map((r) => r.expressionFr),
      (done, total) => setProgress({ done, total })
    );
    applyChunkResults(chunkResults);
    setProgress(null);
    isAnalyzingRef.current = false;
  }

  function applyChunkResults(chunkResults: AiBatchChunkResult[]) {
    const byText = new Map<string, { success: boolean; result?: BatchItemResult; error?: string }>();
    for (const chunk of chunkResults) {
      chunk.sentences.forEach((sentence, i) => {
        byText.set(sentence, chunk.status === 'success' ? { success: true, result: chunk.results?.[i] } : { success: false, error: chunk.error });
      });
    }
    setRows((prev) =>
      prev.map((row) => {
        const outcome = byText.get(row.expressionFr);
        if (!outcome) return row;
        return outcome.success
          ? { ...row, status: 'success', analysis: outcome.result, error: undefined }
          : { ...row, status: 'failed', error: outcome.error };
      })
    );
  }

  async function handleRetryFailed() {
    if (!user || isAnalyzingRef.current) return;
    const failedRows = rows.filter((r) => r.status === 'failed');
    if (failedRows.length === 0) return;
    isAnalyzingRef.current = true;

    setRows((prev) => prev.map((r) => (r.status === 'failed' ? { ...r, status: 'analyzing' } : r)));
    setProgress({ done: 0, total: failedRows.length });
    const chunkResults = await analyzeSentencesInChunks(
      failedRows.map((r) => r.expressionFr),
      (done, total) => setProgress({ done, total })
    );
    applyChunkResults(chunkResults);
    setProgress(null);
    isAnalyzingRef.current = false;
  }

  function updateRow(key: string, patch: Partial<BatchRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function updateAnalysis(key: string, patch: Partial<BatchItemResult>) {
    setRows((prev) =>
      prev.map((r) => (r.key === key && r.analysis ? { ...r, analysis: { ...r.analysis, ...patch } } : r))
    );
  }

  async function handleSave(onlyChecked: boolean) {
    if (!user) return;
    const toSave = rows.filter((r) => r.status === 'success' && r.analysis && (!onlyChecked || r.checked));
    if (toSave.length === 0) return;

    const saveRows: SaveBatchRowInput[] = toSave.map((r) => {
      const a = r.analysis!;
      const finalExpression = r.applyCorrection && a.corrected_fr ? a.corrected_fr : r.expressionFr;
      return {
        expressionFr: finalExpression,
        meaningKo: a.meaning_ko,
        tags: [...r.originalRow.tags, ...a.tags],
        correctedFr: a.corrected_fr,
        keyPhrase: a.key_phrase,
        grammarNote: a.grammar_note,
        cefrLevel: a.cefr_level,
        exampleFr: a.example_fr,
        exampleTranslationKo: a.example_translation_ko,
      };
    });

    const result = await savePasteBatch({
      userId: user.id,
      rawContent: text,
      sourceType: 'manual',
      sourceLabel: null,
      rows: saveRows,
    });

    const savedKeys = new Set(toSave.map((r) => r.key));
    setRows((prev) => prev.filter((r) => !savedKeys.has(r.key)));
    setSaveSummary((prev) => ({
      saved: (prev?.saved ?? 0) + (result.stored === 'online' ? saveRows.length : 0),
      offline: (prev?.offline ?? 0) + (result.stored === 'offline' ? saveRows.length : 0),
    }));
  }

  const duplicateCount = rows.filter((r) => r.status === 'duplicate').length;
  const successCount = rows.filter((r) => r.status === 'success').length;
  const failedCount = rows.filter((r) => r.status === 'failed').length;
  const needsReviewCount = rows.filter((r) => r.status === 'needs_review').length;
  const totalInput = rows.length;

  return (
    <div className="flex flex-col gap-4 p-5">
      <h1 className="text-lg font-bold">AI 일괄 분석</h1>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'프랑스어 문장을 한 줄에 하나씩 붙여넣으세요 (최대 100개)\n입력을 멈추면 1초 후 자동으로 분석을 시작합니다.'}
        rows={8}
        className="w-full rounded-2xl border border-slate-300 bg-white p-4 text-base dark:border-slate-700 dark:bg-slate-900"
      />

      <button
        onClick={() => void runAnalysis()}
        disabled={!text.trim() || isAnalyzingRef.current}
        className="rounded-full bg-blue-600 py-3 text-sm font-semibold text-white disabled:opacity-40"
      >
        지금 분석하기
      </button>

      {progress && (
        <div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full bg-blue-600 transition-all"
              style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {progress.done}/{progress.total} 분석중...
          </p>
        </div>
      )}

      {totalInput > 0 && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          총 {totalInput}개 입력 — 분석 성공 {successCount} · 분석 실패 {failedCount} · 기존 중복 {duplicateCount}
          {needsReviewCount > 0 && ` · 확인 필요 ${needsReviewCount}`}
        </p>
      )}

      {saveSummary && (
        <p className="rounded-xl bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-200">
          저장됨 {saveSummary.saved}개{saveSummary.offline > 0 && ` (오프라인 대기 ${saveSummary.offline}개 포함)`}
        </p>
      )}

      {failedCount > 0 && (
        <button onClick={() => void handleRetryFailed()} className="rounded-full border border-red-400 py-2 text-sm text-red-500">
          실패 항목 재분석 ({failedCount})
        </button>
      )}

      {successCount > 0 && (
        <div className="flex gap-2">
          <button onClick={() => void handleSave(false)} className="flex-1 rounded-full bg-blue-600 py-3 text-sm font-semibold text-white">
            전체 저장
          </button>
          <button onClick={() => void handleSave(true)} className="flex-1 rounded-full border border-slate-300 py-3 text-sm dark:border-slate-700">
            선택 저장
          </button>
        </div>
      )}

      {saveSummary && (
        <button
          onClick={() => navigate('/review?scope=today')}
          className="rounded-full border border-blue-600 py-3 text-sm font-semibold text-blue-600 dark:text-blue-400"
        >
          오늘 배운 표현 복습하기
        </button>
      )}

      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.key} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
            {row.status === 'duplicate' && (
              <p className="text-sm text-slate-400">
                <span className="font-medium text-slate-600 dark:text-slate-300">{row.expressionFr}</span> — 이미 있음:{' '}
                {row.existingMeaningKo ?? '(뜻 없음)'}
              </p>
            )}

            {row.status === 'needs_review' && (
              <p className="text-sm text-amber-600 dark:text-amber-400">확인 필요: {row.originalRow.originalLine}</p>
            )}

            {row.status === 'analyzing' && <p className="text-sm text-slate-400">{row.expressionFr} — 분석중...</p>}

            {row.status === 'failed' && (
              <p className="text-sm text-red-500">
                {row.expressionFr} — 분석 실패 ({row.error})
              </p>
            )}

            {row.status === 'success' && row.analysis && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-base font-medium">
                    <input type="checkbox" checked={row.checked} onChange={(e) => updateRow(row.key, { checked: e.target.checked })} />
                    {row.expressionFr}
                  </label>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800">
                    {row.analysis.cefr_level}
                  </span>
                </div>

                {row.analysis.corrected_fr && (
                  <label className="flex items-center gap-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    <input
                      type="checkbox"
                      checked={row.applyCorrection}
                      onChange={(e) => updateRow(row.key, { applyCorrection: e.target.checked })}
                    />
                    교정문 적용: {row.analysis.corrected_fr}
                  </label>
                )}

                <input
                  value={row.analysis.meaning_ko}
                  onChange={(e) => updateAnalysis(row.key, { meaning_ko: e.target.value })}
                  className="rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
                <textarea
                  value={row.analysis.grammar_note}
                  onChange={(e) => updateAnalysis(row.key, { grammar_note: e.target.value })}
                  rows={2}
                  className="rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
                <input
                  value={row.analysis.example_fr}
                  onChange={(e) => updateAnalysis(row.key, { example_fr: e.target.value })}
                  className="rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
                <input
                  value={row.analysis.example_translation_ko}
                  onChange={(e) => updateAnalysis(row.key, { example_translation_ko: e.target.value })}
                  className="rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
                <p className="text-xs text-slate-400">암기 핵심: {row.analysis.key_phrase} · 태그: {row.analysis.tags.join(', ')}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
