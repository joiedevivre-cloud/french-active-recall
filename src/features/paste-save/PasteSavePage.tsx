import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { parsePasteText, markPasteDuplicates, type PasteParsedRow } from '@/lib/pasteParser';
import type { ExistingExpressionLookup, SourceType } from '@/lib/csvImport';
import { savePasteBatch, undoSavedRows, type SavedRowResult } from '@/features/paste-save/pasteSave';
import { usePasteOfflineSync } from '@/features/paste-save/usePasteOfflineSync';

const SOURCE_OPTIONS: { label: string; type: SourceType }[] = [
  { label: '학교 수업', type: 'school' },
  { label: 'TV5MONDE', type: 'tv5monde' },
  { label: '일상 대화', type: 'daily' },
  { label: '뉴스', type: 'news' },
  { label: '영상', type: 'video' },
  { label: '기타', type: 'import' },
];

const LAST_SOURCE_KEY = 'fr_paste_last_source_label';

type SavedRowWithRow = SavedRowResult & { tags: string[] };

interface ResultState {
  stored: 'online' | 'offline';
  saved: SavedRowWithRow[];
  duplicates: PasteParsedRow[];
  needsReview: PasteParsedRow[];
}

export default function PasteSavePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pendingCount } = usePasteOfflineSync();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [text, setText] = useState('');
  const [sourceLabel, setSourceLabel] = useState(() => localStorage.getItem(LAST_SOURCE_KEY) ?? '학교 수업');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ResultState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMeaning, setEditMeaning] = useState('');

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    localStorage.setItem(LAST_SOURCE_KEY, sourceLabel);
  }, [sourceLabel]);

  async function handlePasteButton() {
    try {
      const clipboardText = await navigator.clipboard.readText();
      setText((prev) => (prev ? `${prev}\n${clipboardText}` : clipboardText));
      textareaRef.current?.focus();
    } catch {
      // Clipboard permission denied/unsupported -- the user can still long-press-paste manually.
    }
  }

  async function handleSave() {
    if (!user || !text.trim() || saving) return;
    setSaving(true);

    const sourceType = SOURCE_OPTIONS.find((o) => o.label === sourceLabel)?.type ?? 'import';
    const { rows } = parsePasteText(text);

    let existing: ExistingExpressionLookup[] = [];
    if (navigator.onLine) {
      const { data } = await supabase
        .from('expressions')
        .select('id, expression_fr, meaning_ko')
        .eq('user_id', user.id)
        .is('deleted_at', null);
      existing = data ?? [];
    }

    const marked = markPasteDuplicates(rows, existing);
    const newRows = marked.filter((r) => r.status === 'new');
    const duplicates = marked.filter((r) => r.status === 'duplicate');
    const needsReview = marked.filter((r) => r.status === 'needs_review');

    const saveResult = await savePasteBatch({
      userId: user.id,
      rawContent: text,
      sourceType,
      sourceLabel,
      rows: newRows,
    });

    setResult({
      stored: saveResult.stored,
      saved:
        saveResult.stored === 'online'
          ? saveResult.saved.map((s, i) => ({ ...s, tags: newRows[i]?.tags ?? [] }))
          : newRows.map((r) => ({
              rowClientId: crypto.randomUUID(),
              expressionId: '',
              expressionFr: r.expressionFr,
              meaningKo: r.meaningKo,
              tags: r.tags,
            })),
      duplicates,
      needsReview,
    });
    setSaving(false);
  }

  function handleStartNewPaste() {
    setText('');
    setResult(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  async function handleUndoAll() {
    if (!result) return;
    const ids = result.saved.map((s) => s.expressionId).filter(Boolean);
    await undoSavedRows(ids);
    setResult(null);
    setText('');
  }

  async function handleDeleteSavedRow(expressionId: string) {
    if (!expressionId) return;
    await supabase.from('expressions').update({ deleted_at: new Date().toISOString() }).eq('id', expressionId);
    setResult((prev) => (prev ? { ...prev, saved: prev.saved.filter((s) => s.expressionId !== expressionId) } : prev));
  }

  async function handleSaveEdit(expressionId: string) {
    await supabase.from('expressions').update({ meaning_ko: editMeaning || null }).eq('id', expressionId);
    setResult((prev) =>
      prev
        ? { ...prev, saved: prev.saved.map((s) => (s.expressionId === expressionId ? { ...s, meaningKo: editMeaning } : s)) }
        : prev
    );
    setEditingId(null);
  }

  if (result) {
    return (
      <div className="flex flex-col gap-4 p-5">
        <h1 className="text-lg font-bold">저장 결과</h1>
        <p className="text-base">
          {result.stored === 'offline'
            ? `오프라인 저장 대기 ${result.saved.length}개 · 이미 있음 ${result.duplicates.length}개 · 확인 필요 ${result.needsReview.length}줄`
            : `${result.saved.length}개 저장 · 이미 있음 ${result.duplicates.length}개 · 확인 필요 ${result.needsReview.length}줄`}
        </p>
        {result.stored === 'offline' && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            오프라인 상태라 저장 대기열에 넣었어요. 온라인이 되면 자동으로 업로드됩니다.
          </p>
        )}

        {result.saved.length > 0 && (
          <ul className="flex flex-col gap-2">
            {result.saved.map((row) => (
              <li key={row.rowClientId} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <p className="font-medium">{row.expressionFr}</p>
                {editingId === row.expressionId ? (
                  <div className="mt-1 flex gap-2">
                    <input
                      autoFocus
                      value={editMeaning}
                      onChange={(e) => setEditMeaning(e.target.value)}
                      className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
                    />
                    <button onClick={() => void handleSaveEdit(row.expressionId)} className="text-sm text-blue-600">
                      저장
                    </button>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">{row.meaningKo || 'AI 분석 대기중'}</p>
                )}
                {result.stored === 'online' && (
                  <div className="mt-1 flex gap-3 text-xs text-slate-400">
                    <button
                      onClick={() => {
                        setEditingId(row.expressionId);
                        setEditMeaning(row.meaningKo);
                      }}
                    >
                      수정
                    </button>
                    <button onClick={() => void handleDeleteSavedRow(row.expressionId)} className="text-red-400">
                      삭제
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {result.duplicates.length > 0 && (
          <details className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-800">
            <summary>이미 있음 ({result.duplicates.length}개) — 펼쳐서 보기</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {result.duplicates.map((row) => (
                <li key={row.lineNumber} className="text-slate-500">
                  {row.expressionFr} → 기존: {row.existingMeaningKo ?? '(뜻 없음)'}
                </li>
              ))}
            </ul>
          </details>
        )}

        {result.needsReview.length > 0 && (
          <details open className="rounded-xl border border-amber-300 p-3 text-sm dark:border-amber-700">
            <summary>확인 필요 ({result.needsReview.length}줄)</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {result.needsReview.map((row) => (
                <li key={row.lineNumber} className="text-amber-700 dark:text-amber-300">
                  {row.lineNumber}번째 줄: {row.originalLine}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="mt-2 flex flex-col gap-2">
          <button
            onClick={() => navigate('/review?scope=today')}
            className="rounded-full bg-blue-600 py-3 text-sm font-semibold text-white"
          >
            오늘 배운 표현 복습하기
          </button>
          <button onClick={handleStartNewPaste} className="rounded-full border border-slate-300 py-3 text-sm dark:border-slate-700">
            다시 붙여넣기
          </button>
          {result.stored === 'online' && result.saved.length > 0 && (
            <button onClick={() => void handleUndoAll()} className="text-sm text-red-400">
              이번 저장 전체 취소
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">붙여넣기 저장</h1>
        {pendingCount > 0 && <span className="text-xs text-amber-600">오프라인 대기 {pendingCount}건</span>}
      </div>

      <select
        value={sourceLabel}
        onChange={(e) => setSourceLabel(e.target.value)}
        className="w-full rounded-xl border border-slate-300 p-3 text-sm dark:border-slate-700 dark:bg-slate-900"
      >
        {SOURCE_OPTIONS.map((o) => (
          <option key={o.label} value={o.label}>
            {o.label}
          </option>
        ))}
      </select>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="ChatGPT가 정리해준 표현을 여기에 붙여넣으세요"
        rows={10}
        className="w-full rounded-2xl border border-slate-300 bg-white p-4 text-base dark:border-slate-700 dark:bg-slate-900"
      />

      <button
        onClick={() => void handlePasteButton()}
        className="rounded-full border border-slate-300 py-2 text-sm dark:border-slate-700"
      >
        붙여넣기
      </button>

      <button
        onClick={() => void handleSave()}
        disabled={!text.trim() || saving}
        className="rounded-full bg-blue-600 py-4 text-lg font-semibold text-white disabled:opacity-40"
      >
        {saving ? '저장중...' : '저장'}
      </button>
    </div>
  );
}
