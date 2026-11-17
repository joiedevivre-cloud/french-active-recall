import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { addExpression } from '@/features/capture/addExpression';

interface SavedItem {
  id: string;
  text: string;
}

interface QuickAddFormProps {
  sourceType: string;
  /** Class mode hides toasts/checkmarks sound and keeps the UI minimal. */
  silent?: boolean;
  onSaved?: (item: SavedItem) => void;
}

export function QuickAddForm({ sourceType, silent, onSaved }: QuickAddFormProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [context, setContext] = useState('');
  const [saving, setSaving] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [sessionItems, setSessionItems] = useState<SavedItem[]>([]);

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

    const savedItem: SavedItem = { id: result.expressionId ?? crypto.randomUUID(), text: text.trim() };
    setSessionItems((prev) => [savedItem, ...prev]);
    onSaved?.(savedItem);

    setText('');
    setContext('');
    setSaving(false);

    if (!silent) {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 900);
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
          placeholder="들은 프랑스어 표현을 입력하세요 (예: relever un defi)"
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

      {savedFlash && <div className="text-center text-sm text-green-600">저장됨 ✓</div>}

      {sessionItems.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">오늘 저장한 표현 ({sessionItems.length})</p>
          <ul className="flex flex-col gap-1">
            {sessionItems.map((item) => (
              <li key={item.id} className="rounded-lg bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800">
                {item.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
