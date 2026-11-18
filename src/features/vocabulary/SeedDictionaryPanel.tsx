import { useState } from 'react';
import { applySeedDictionary, previewSeedDictionary, type PreparedSense, type SeedPreview } from '@/features/vocabulary/lemmaClient';

/**
 * "사전 쓰임 추가 (AI)": preview first -- the word's constructions surveyed by
 * one model, checked (and completed with missing constructions) by a
 * stronger one, then the code rules. 핵심 쓰임 are preselected, 추가 쓰임
 * are shown unticked. Nothing is written before [선택한 쓰임 저장].
 */
export function SeedDictionaryPanel({ lemmaId, onSaved }: { lemmaId: string; onSaved: () => void }) {
  const [preview, setPreview] = useState<SeedPreview | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  /** index -> merge into the similar existing usage (default) instead of a new usage */
  const [mergeSimilar, setMergeSimilar] = useState<Map<number, boolean>>(new Map());
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    setSavedNote(null);
    try {
      const p = await previewSeedDictionary(lemmaId);
      setPreview(p);
      setPicked(new Set(p.senses.flatMap((s, i) => (s.tier === 'core' ? [i] : []))));
      setMergeSimilar(new Map(p.senses.flatMap((s, i) => (s.similarTargetId ? [[i, true] as [number, boolean]] : []))));
    } catch (err) {
      setError(`사전 쓰임 생성 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const runApply = async () => {
    if (!preview) return;
    const chosen = preview.senses
      .map((s, i) => ({ ...s, mergeInto: s.mergeTargetId ?? (s.similarTargetId && mergeSimilar.get(i) ? s.similarTargetId : null) }))
      .filter((_, i) => picked.has(i));
    if (chosen.length === 0) return;
    setBusy('apply');
    setError(null);
    try {
      const result = await applySeedDictionary(lemmaId, chosen);
      setPreview(null);
      setSavedNote(
        `${result.usageIds.length}개 저장했어요.${result.rejected.length ? ` (${result.rejected.length}개는 저장하지 못함: ${result.rejected.map((r) => r.reason_ko).join(' / ')})` : ''}`
      );
      onSaved();
    } catch (err) {
      setError(`저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (i: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  if (!preview) {
    return (
      <div className="mt-3 flex flex-col gap-1">
        <button
          onClick={runPreview}
          disabled={busy !== null}
          className="w-full rounded-full border border-slate-300 py-2 text-xs text-slate-500 disabled:opacity-40 dark:border-slate-700"
        >
          {busy === 'preview' ? '쓰임 조사·검증 중... (30~60초)' : '사전 쓰임 추가 (AI)'}
        </button>
        {savedNote && <p className="text-xs text-emerald-600">{savedNote}</p>}
        {error && <p className="text-xs text-rose-500">{error}</p>}
      </div>
    );
  }

  const indexed = preview.senses.map((s, i) => ({ s, i }));
  const core = indexed.filter((x) => x.s.tier === 'core');
  const extra = indexed.filter((x) => x.s.tier === 'extra');

  const card = ({ s, i }: { s: PreparedSense; i: number }) => (
    <div key={i} className="flex gap-2 rounded-xl border border-slate-100 p-2 dark:border-slate-800">
      <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} className="mt-1" aria-label={`${s.pattern} 선택`} />
      <span className="flex min-w-0 flex-col gap-1">
        <span>
          <span className="font-medium">{s.pattern}</span>
          <span className="ml-1 text-slate-500">— {s.label}</span>
        </span>
        {s.grammar_terms.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {s.grammar_terms.map((t) => (
              <span key={t} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {t}
              </span>
            ))}
          </span>
        )}
        {s.contrast_ko && <span className="text-xs text-slate-600 dark:text-slate-300">{s.contrast_ko}</span>}
        {s.mood_note_ko && <span className="text-xs text-violet-600">{s.mood_note_ko}</span>}
        {s.mergeTargetId && <span className="text-xs text-sky-600">기존 쓰임 "{s.mergeTargetLabel}"과 같은 구문이에요. 새 쓰임을 만들지 않고 예문만 추가해요.</span>}
        {s.similarTargetId && (
          <span className="flex flex-col gap-0.5 text-xs text-sky-600">
            <span>
              기존 쓰임 "{s.similarTargetLabel}" ({s.similarTargetPattern})과 qqn/qqch만 달라요.
            </span>
            <span className="flex gap-3">
              <label className="flex items-center gap-1">
                <input type="radio" checked={mergeSimilar.get(i) === true} onChange={() => setMergeSimilar((m) => new Map(m).set(i, true))} />
                예문만 추가
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={mergeSimilar.get(i) === false} onChange={() => setMergeSimilar((m) => new Map(m).set(i, false))} />
                새 쓰임으로
              </label>
            </span>
          </span>
        )}
        {s.checked === 'fix' && s.note_ko && <span className="text-xs text-amber-600">검증에서 수정됨: {s.note_ko}</span>}
        {s.checked === 'added' && <span className="text-xs text-amber-600">{s.note_ko}</span>}
        {s.examples.map((e) => (
          <span key={e.fr} className="break-words text-xs text-slate-500">
            {e.fr} — {e.ko}
          </span>
        ))}
      </span>
    </div>
  );

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-2xl border border-slate-200 p-3 text-sm dark:border-slate-800">
      <p className="text-xs text-slate-400">
        미리보기예요. 아직 저장되지 않았어요. 틀려 보이는 쓰임은 체크를 풀어 주세요.
        {preview.models && ` (조사 ${preview.models.generate} · 검증 ${preview.models.verify})`}
      </p>
      <p className="text-xs text-slate-500">
        핵심 {core.length} · 추가 {extra.length} · 검증에서 보탬 {preview.senses.filter((s) => s.checked === 'added').length} · 기존과 같은 구문{' '}
        {preview.senses.filter((s) => s.mergeTargetId).length} · 비슷한 기존 쓰임 {preview.senses.filter((s) => s.similarTargetId).length} · 제외{' '}
        {preview.rejected.length}
      </p>
      {preview.senses.length === 0 && <p className="text-slate-500">추가할 쓰임이 없어요.</p>}
      {core.length > 0 && <p className="text-xs font-medium text-slate-500">핵심 쓰임</p>}
      {core.map(card)}
      {extra.length > 0 && <p className="text-xs font-medium text-slate-500">추가 쓰임 (덜 자주 쓰여요. 필요하면 체크하세요)</p>}
      {extra.map(card)}
      <details className="text-xs text-slate-500" open={preview.rejected.length > 0}>
        <summary>제외된 쓰임 {preview.rejected.length}개</summary>
        {preview.rejected.length === 0 ? (
          <p className="mt-1 text-slate-400">없어요.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {preview.rejected.map((r, i) => (
              <li key={i}>
                {r.label} <span className="text-slate-400">({r.pattern})</span> — {r.reason_ko}
              </li>
            ))}
          </ul>
        )}
      </details>
      <div className="flex gap-2">
        <button
          onClick={runApply}
          disabled={busy !== null || picked.size === 0}
          className="flex-1 rounded-full bg-slate-900 py-2 text-xs text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy === 'apply' ? '저장 중...' : `선택한 쓰임 저장 (${picked.size})`}
        </button>
        <button onClick={() => setPreview(null)} disabled={busy !== null} className="rounded-full border border-slate-300 px-4 py-2 text-xs dark:border-slate-700">
          취소
        </button>
      </div>
      {error && <p className="text-xs text-rose-500">{error}</p>}
    </div>
  );
}
