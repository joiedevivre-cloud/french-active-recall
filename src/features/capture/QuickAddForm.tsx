import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { addExpression } from '@/features/capture/addExpression';

interface QuickAddFormProps {
  sourceType: string;
  /** Class mode hides toasts/checkmarks sound and keeps the UI minimal. */
  silent?: boolean;
  /** Called after every save attempt (online or queued offline) so the
   * parent can refresh its "오늘 저장한 표현" list. */
  onSaved?: () => void;
}

export function QuickAddForm({ sourceType, silent, onSaved }: QuickAddFormProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [context, setContext] = useState('');
  const [saving, setSaving] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  async function handleSave(andPractice: boolean) {
    if (!user || !text.trim() || saving) return;
    setSaving(true);
    setDuplicateWarning(null);

    const result = await addExpression({
      userId: user.id,
      expressionFr: text.trim(),
      sourceType,
      originalContext: context.trim() || null,
    });

    if (result.possibleDuplicate) {
      setDuplicateWarning(`이미 저장된 표현일 수 있어요: "${result.possibleDuplicate.expression_fr}"`);
    }

    onSaved?.();
    setText('');
    setContext('');
    setSaving(false);

    if (!silent) {
      setSavedFlash(
        result.stored === 'offline'
          ? `${result.savedCount}개 오프라인 저장 대기중`
          : result.savedCount > 1
            ? `${result.savedCount}개 저장됨 ✓`
            : '저장됨 ✓'
      );
      setTimeout(() => setSavedFlash(null), 1500);
    }

    if (andPractice) {
      navigate('/review');
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void handleSave(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="들은 프랑스어 표현을 입력하세요 (예: relever un défi, 또는 여러 줄로 'fr — 뜻')"
          rows={3}
          className="w-full rounded-2xl border border-slate-300 bg-white p-4 text-lg dark:border-slate-700 dark:bg-slate-900"
        />
        <input
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="출처/상황 (선택, 예: 오늘 수업, TV5MONDE)"
          className="w-full rounded-xl border border-slate-300 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900"
        />

        {duplicateWarning && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {duplicateWarning}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={!text.trim() || saving}
            className="flex-1 rounded-full bg-blue-600 py-4 text-lg font-semibold text-white disabled:opacity-40"
          >
            저장하고 계속
          </button>
        </div>
        <div className="flex gap-3 text-sm">
          <button
            type="button"
            onClick={() => void handleSave(false)}
            disabled={!text.trim() || saving}
            className="flex-1 rounded-full border border-slate-300 py-2 dark:border-slate-700"
          >
            저장하고 끝내기
          </button>
          <button
            type="button"
            onClick={() => void handleSave(true)}
            disabled={!text.trim() || saving}
            className="flex-1 rounded-full border border-slate-300 py-2 dark:border-slate-700"
          >
            지금 연습하기
          </button>
        </div>
      </form>

      {savedFlash && <div className="text-center text-sm text-green-600">{savedFlash}</div>}
    </div>
  );
}
