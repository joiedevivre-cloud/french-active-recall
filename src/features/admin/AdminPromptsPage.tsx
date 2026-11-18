import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { isAdminSession } from '@/lib/isAdmin';
import { diffLines } from '@/lib/lineDiff';
import { checkTemplate } from '../../../supabase/functions/_shared/promptTemplate';
import {
  adminPrompts,
  AdminPromptsError,
  runWithConcurrency,
  type PromptOverview,
  type PromptVersion,
} from '@/features/admin/adminPromptsClient';
import {
  activationGate,
  compareOutputs,
  compareSummary,
  latestRuns,
  runKey,
  type PromptTestRun,
} from '@/features/admin/compareRuns';

type Tab = 'versions' | 'edit' | 'test';

const STATUS_STYLE: Record<PromptVersion['status'], string> = {
  active: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  draft: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  archived: 'bg-slate-100 text-slate-500 dark:bg-slate-800',
};
const STATUS_LABEL: Record<PromptVersion['status'], string> = { active: '활성', draft: '초안', archived: '보관' };

function errorText(err: unknown): string {
  if (err instanceof AdminPromptsError) return [err.message, ...err.details].join(' · ');
  return err instanceof Error ? err.message : String(err);
}

/**
 * /admin/prompts -- admin-only prompt management (stage 1).
 * The menu/route is hidden for non-admins as a convenience only; every
 * action goes through the admin-prompts Edge Function, which returns 403
 * for anyone whose JWT app_metadata.role is not 'admin'.
 */
export default function AdminPromptsPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAdmin = isAdminSession(session);
  const [tab, setTab] = useState<Tab>('versions');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const overviewQuery = useQuery({
    queryKey: ['admin-prompts-overview'],
    enabled: isAdmin,
    queryFn: () => adminPrompts.overview(),
  });
  const overview = overviewQuery.data;
  const active = overview?.versions.find((v) => v.status === 'active') ?? null;
  const drafts = overview?.versions.filter((v) => v.status === 'draft') ?? [];

  // Version being edited / tested as "B" (default: newest draft).
  const [draftId, setDraftId] = useState<string | null>(null);
  useEffect(() => {
    if (!overview) return;
    if (draftId && overview.versions.some((v) => v.id === draftId && v.status === 'draft')) return;
    setDraftId(drafts[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview]);
  const draft = overview?.versions.find((v) => v.id === draftId) ?? null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-prompts-overview'] });

  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-3 p-5">
        <button onClick={() => navigate(-1)} className="self-start text-sm text-slate-400">← 뒤로</button>
        <p className="text-sm text-slate-500">관리자 전용 화면입니다. (권한은 서버에서 확인합니다.)</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="text-sm text-slate-400">← 뒤로</button>
        <h1 className="text-base font-bold">프롬프트 관리 · sentence-analysis</h1>
      </div>

      <div className="flex gap-1 rounded-full bg-slate-100 p-1 text-sm dark:bg-slate-800">
        {(
          [
            ['versions', '버전'],
            ['edit', '편집'],
            ['test', '테스트·비교'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 rounded-full py-1.5 ${tab === key ? 'bg-white font-semibold shadow dark:bg-slate-900' : 'text-slate-500'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {message && (
        <p className={`rounded-xl p-3 text-sm ${message.kind === 'ok' ? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300' : 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-300'}`}>
          {message.text}
        </p>
      )}

      {overviewQuery.isLoading && <p className="text-sm text-slate-400">불러오는 중...</p>}
      {overviewQuery.error && <p className="text-sm text-red-500">불러오기 실패: {errorText(overviewQuery.error)}</p>}

      {overview && tab === 'versions' && (
        <VersionsTab
          overview={overview}
          active={active}
          onEdit={(id) => {
            setDraftId(id);
            setTab('edit');
          }}
          onRestored={async (newId, fromNo) => {
            await refresh();
            setDraftId(newId);
            setTab('test');
            setMessage({ kind: 'ok', text: `v${fromNo}을(를) 복사한 새 초안을 만들었습니다. 테스트 세트를 실행한 뒤 활성화하세요.` });
          }}
          onError={(text) => setMessage({ kind: 'error', text })}
        />
      )}

      {overview && tab === 'edit' && (
        <EditTab
          key={draft?.id ?? 'new'}
          overview={overview}
          active={active}
          draft={draft}
          drafts={drafts}
          onSelectDraft={setDraftId}
          onSaved={async (id) => {
            await refresh();
            setDraftId(id);
            setMessage({ kind: 'ok', text: '초안을 저장했습니다. 이전 테스트 결과는 수정 이후에는 활성화 조건에 포함되지 않습니다.' });
          }}
          onDeleted={async () => {
            await refresh();
            setDraftId(null);
            setMessage({ kind: 'ok', text: '초안을 삭제했습니다.' });
          }}
          onGoTest={() => setTab('test')}
          onError={(text) => setMessage({ kind: 'error', text })}
        />
      )}

      {overview && tab === 'test' && (
        <TestTab
          overview={overview}
          active={active}
          draft={draft}
          onActivated={async (versionNo) => {
            await refresh();
            setDraftId(null);
            setTab('versions');
            setMessage({ kind: 'ok', text: `v${versionNo}을(를) 활성화했습니다. 각 함수 인스턴스에는 최대 60초 안에 반영됩니다.` });
          }}
          onError={(text) => setMessage({ kind: 'error', text })}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------

function VersionsTab({
  overview,
  active,
  onEdit,
  onRestored,
  onError,
}: {
  overview: PromptOverview;
  active: PromptVersion | null;
  onEdit: (id: string) => void;
  onRestored: (newId: string, fromNo: number) => void;
  onError: (text: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [diffId, setDiffId] = useState<string | null>(null);

  return (
    <ul className="flex flex-col gap-2">
      {overview.versions.map((v) => (
        <li key={v.id} className="rounded-2xl border border-slate-200 p-3 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">v{v.version_no}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[v.status]}`}>{STATUS_LABEL[v.status]}</span>
            <span className="text-xs text-slate-400">{v.model}{v.temperature !== null ? ` · t=${v.temperature}` : ''}</span>
            <span className="ml-auto text-xs text-slate-400">
              {new Date(v.activated_at ?? v.created_at).toLocaleString('ko-KR')}
            </span>
          </div>
          {v.change_note && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{v.change_note}</p>}
          {v.based_on_version_id && (
            <p className="text-xs text-slate-400">
              기반: v{overview.versions.find((x) => x.id === v.based_on_version_id)?.version_no ?? '?'}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {v.status === 'draft' && (
              <button onClick={() => onEdit(v.id)} className="rounded-full border border-slate-300 px-3 py-1 dark:border-slate-700">편집</button>
            )}
            {v.status !== 'draft' && (
              <button
                disabled={busyId === v.id}
                onClick={async () => {
                  setBusyId(v.id);
                  try {
                    const res = await adminPrompts.restore(v.id);
                    onRestored(res.version.id, res.restoredFrom);
                  } catch (err) {
                    onError(`복원 실패: ${errorText(err)}`);
                  } finally {
                    setBusyId(null);
                  }
                }}
                className="rounded-full border border-slate-300 px-3 py-1 disabled:opacity-40 dark:border-slate-700"
              >
                {busyId === v.id ? '복원 중...' : '복원 (새 초안으로 복사)'}
              </button>
            )}
            {active && v.id !== active.id && (
              <button onClick={() => setDiffId(diffId === v.id ? null : v.id)} className="rounded-full border border-slate-300 px-3 py-1 dark:border-slate-700">
                {diffId === v.id ? 'diff 닫기' : `활성(v${active.version_no})과 diff`}
              </button>
            )}
          </div>
          {diffId === v.id && active && <TextDiff before={active.instructions} after={v.instructions} beforeLabel={`v${active.version_no}`} afterLabel={`v${v.version_no}`} />}
        </li>
      ))}
    </ul>
  );
}

// -----------------------------------------------------------------------------

function EditTab({
  overview,
  active,
  draft,
  drafts,
  onSelectDraft,
  onSaved,
  onDeleted,
  onGoTest,
  onError,
}: {
  overview: PromptOverview;
  active: PromptVersion | null;
  draft: PromptVersion | null;
  drafts: PromptVersion[];
  onSelectDraft: (id: string) => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  onGoTest: () => void;
  onError: (text: string) => void;
}) {
  const base = draft ?? active;
  const [instructions, setInstructions] = useState(base?.instructions ?? overview.defaultInstructions);
  const [model, setModel] = useState(base?.model ?? overview.allowedModels[0] ?? 'gpt-4o-mini');
  const [temperature, setTemperature] = useState(base?.temperature === null || base?.temperature === undefined ? '' : String(base.temperature));
  const [saving, setSaving] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  const template = checkTemplate(instructions);
  const dirty = !draft || instructions !== draft.instructions || model !== draft.model || temperature !== (draft.temperature === null ? '' : String(draft.temperature));

  async function save() {
    if (template.unknownVariables.length > 0 || template.malformed) return;
    setSaving(true);
    try {
      const t = temperature.trim() === '' ? null : Number(temperature);
      const saved = await adminPrompts.saveDraft({
        versionId: draft?.id ?? null,
        instructions,
        settings: (base?.settings as Record<string, unknown>) ?? overview.defaultSettings,
        model,
        temperature: t,
        basedOnVersionId: draft ? draft.based_on_version_id : active?.id ?? null,
      });
      onSaved(saved.id);
    } catch (err) {
      onError(`저장 실패: ${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-400">편집 대상:</span>
        {drafts.length === 0 && <span>새 초안 (활성 v{active?.version_no ?? '-'} 기반)</span>}
        {drafts.length > 0 && (
          <select
            value={draft?.id ?? ''}
            onChange={(e) => onSelectDraft(e.target.value)}
            className="rounded-lg border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700"
          >
            {drafts.map((d) => (
              <option key={d.id} value={d.id}>
                v{d.version_no} (초안)
              </option>
            ))}
          </select>
        )}
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">instructions (편집 가능)</span>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={16}
          spellCheck={false}
          className="w-full rounded-xl border border-slate-300 p-3 font-mono text-xs leading-relaxed dark:border-slate-700 dark:bg-slate-900"
        />
      </label>

      <div className="text-xs">
        <p className="text-slate-400">사용 가능한 변수 (settings 값으로 치환):</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {overview.availableVariables.map((v) => (
            <button
              key={v}
              onClick={() => setInstructions((s) => `${s}{{${v}}}`)}
              className="rounded-full bg-slate-100 px-2 py-0.5 font-mono dark:bg-slate-800"
              title={`현재 값: ${String((base?.settings as Record<string, unknown>)?.[v] ?? overview.defaultSettings[v])}`}
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
        {template.unknownVariables.length > 0 && (
          <p className="mt-1 text-red-500">알 수 없는 변수: {template.unknownVariables.map((v) => `{{${v}}}`).join(', ')} — 저장할 수 없습니다.</p>
        )}
        {template.malformed && <p className="mt-1 text-red-500">{'{{ }}'} 형식이 잘못된 부분이 있습니다.</p>}
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-2">
          model
          <select value={model} onChange={(e) => setModel(e.target.value)} className="rounded-lg border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700">
            {overview.allowedModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          temperature
          <input
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            placeholder="기본값"
            inputMode="decimal"
            className="w-20 rounded-lg border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700"
          />
        </label>
      </div>

      <details className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
        <summary className="cursor-pointer text-sm font-medium">🔒 출력 형식 (output contract, 읽기 전용 · 항상 instructions 뒤에 자동으로 붙음)</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-slate-500">{overview.outputContract}</pre>
      </details>

      {active && (
        <button onClick={() => setShowDiff((s) => !s)} className="self-start text-xs text-blue-600 dark:text-blue-400">
          {showDiff ? 'diff 닫기' : `활성(v${active.version_no})과 비교한 diff 보기`}
        </button>
      )}
      {showDiff && active && <TextDiff before={active.instructions} after={instructions} beforeLabel={`v${active.version_no}`} afterLabel="편집 중" />}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={save}
          disabled={saving || !dirty || template.unknownVariables.length > 0 || template.malformed}
          className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          {saving ? '저장 중...' : '초안 저장'}
        </button>
        <button
          onClick={onGoTest}
          disabled={!draft || dirty}
          title={dirty ? '먼저 초안을 저장하세요' : undefined}
          className="rounded-full border border-slate-300 px-4 py-2 text-sm disabled:opacity-40 dark:border-slate-700"
        >
          테스트 실행 · 비교 · 활성화 →
        </button>
        {draft && (
          <button
            onClick={async () => {
              if (!window.confirm(`초안 v${draft.version_no}을(를) 삭제할까요?`)) return;
              try {
                await adminPrompts.deleteDraft(draft.id);
                onDeleted();
              } catch (err) {
                onError(`삭제 실패: ${errorText(err)}`);
              }
            }}
            className="ml-auto rounded-full px-3 py-2 text-xs text-red-500"
          >
            초안 삭제
          </button>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

function TestTab({
  overview,
  active,
  draft,
  onActivated,
  onError,
}: {
  overview: PromptOverview;
  active: PromptVersion | null;
  draft: PromptVersion | null;
  onActivated: (versionNo: number) => void;
  onError: (text: string) => void;
}) {
  const nonDraftDefault = active?.id ?? overview.versions[0]?.id ?? '';
  const [aId, setAId] = useState(nonDraftDefault);
  const [bId, setBId] = useState(draft?.id ?? '');
  useEffect(() => {
    if (draft) setBId(draft.id);
  }, [draft]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(overview.testCases.map((c) => c.id)));
  const [custom, setCustom] = useState('');
  const [runsA, setRunsA] = useState<PromptTestRun[]>([]);
  const [runsB, setRunsB] = useState<PromptTestRun[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [activating, setActivating] = useState(false);

  const versionA = overview.versions.find((v) => v.id === aId) ?? null;
  const versionB = overview.versions.find((v) => v.id === bId) ?? null;

  async function reloadRuns() {
    const [ra, rb] = await Promise.all([aId ? adminPrompts.runs(aId) : [], bId ? adminPrompts.runs(bId) : []]);
    setRunsA(ra);
    setRunsB(rb);
  }
  useEffect(() => {
    void reloadRuns().catch((err) => onError(`결과 불러오기 실패: ${errorText(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aId, bId]);

  useEffect(() => {
    if (versionB?.based_on_version_id && !changeNote) {
      const src = overview.versions.find((v) => v.id === versionB.based_on_version_id);
      if (src && src.status !== 'active' && versionB.instructions === src.instructions) setChangeNote(`v${src.version_no} 복원`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionB?.id]);

  async function run(versionIds: string[], targets: ({ testCaseId: string } | { sentence: string })[]) {
    const jobs = versionIds.flatMap((versionId) => targets.map((target) => ({ versionId, target })));
    if (jobs.length === 0) return;
    setProgress({ done: 0, total: jobs.length });
    let failures = 0;
    let lastError = '';
    await runWithConcurrency(jobs, 3, async ({ versionId, target }) => {
      try {
        await adminPrompts.preview(versionId, target);
      } catch (err) {
        failures++;
        lastError = errorText(err);
      }
      setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
    });
    setProgress(null);
    await reloadRuns();
    if (failures > 0) onError(`${failures}건 실행 실패 (마지막 오류: ${lastError})`);
  }

  const targets = [
    ...overview.testCases.filter((c) => selected.has(c.id)).map((c) => ({ testCaseId: c.id })),
    ...(custom.trim() ? [{ sentence: custom.trim() }] : []),
  ];

  const latestA = useMemo(() => latestRuns(runsA), [runsA]);
  const latestB = useMemo(() => latestRuns(runsB), [runsB]);
  const rowKeys = [
    ...overview.testCases.map((c) => c.id),
    ...new Set([...runsA, ...runsB].filter((r) => !r.test_case_id).map((r) => runKey(r))),
  ];
  const shownKeys = rowKeys.filter((k) => latestA.has(k) || latestB.has(k));
  const summary = compareSummary(overview.testCases.map((c) => c.id), latestA, latestB);
  const gate = versionB?.status === 'draft' ? activationGate(overview.testCases.map((c) => c.id), runsB, versionB.updated_at) : null;
  const sentenceFor = (key: string) => overview.testCases.find((c) => c.id === key)?.expression_fr ?? key.replace(/^custom:/, '');

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <VersionSelect label="A" value={aId} onChange={setAId} versions={overview.versions} />
        <VersionSelect label="B" value={bId} onChange={setBId} versions={overview.versions} />
      </div>

      <details className="rounded-xl border border-slate-200 p-3 dark:border-slate-800" open={false}>
        <summary className="cursor-pointer text-sm font-medium">
          문장 선택 ({selected.size}/{overview.testCases.length}{custom.trim() ? ' + 직접 입력 1' : ''})
        </summary>
        <div className="mt-2 flex gap-3 text-xs">
          <button onClick={() => setSelected(new Set(overview.testCases.map((c) => c.id)))} className="text-blue-600 dark:text-blue-400">전체 선택</button>
          <button onClick={() => setSelected(new Set())} className="text-slate-400">선택 해제</button>
        </div>
        <ul className="mt-2 flex flex-col gap-1">
          {overview.testCases.map((c) => (
            <li key={c.id}>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    setSelected(next);
                  }}
                  className="mt-1"
                />
                <span>
                  {c.expression_fr}
                  {c.note && <span className="block text-xs text-slate-400">{c.note}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="직접 입력한 문장 1개 (선택)"
          className="mt-2 w-full rounded-lg border border-slate-300 bg-transparent p-2 text-sm dark:border-slate-700"
        />
      </details>

      <div className="flex flex-wrap gap-2">
        <button
          disabled={!!progress || !aId || !bId || targets.length === 0}
          onClick={() => run([aId, bId].filter((v, i, arr) => v && arr.indexOf(v) === i), targets)}
          className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          A·B 같은 문장으로 실행 ({targets.length}문장)
        </button>
        {versionB?.status === 'draft' && (
          <button
            disabled={!!progress}
            onClick={() => run([versionB.id], overview.testCases.map((c) => ({ testCaseId: c.id })))}
            className="rounded-full border border-slate-300 px-4 py-2 text-sm disabled:opacity-40 dark:border-slate-700"
          >
            B 테스트 세트 전체 실행
          </button>
        )}
      </div>
      {progress && (
        <div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div className="h-full bg-blue-600 transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
          <p className="mt-1 text-xs text-slate-400">실행 중 {progress.done}/{progress.total} (동시 3개) — 결과는 prompt_test_runs에만 저장되고 학습 데이터에는 쓰지 않습니다.</p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <Stat label={`A 스키마 통과 (v${versionA?.version_no ?? '-'})`} value={`${summary.passA}/${summary.total}`} />
        <Stat label={`B 스키마 통과 (v${versionB?.version_no ?? '-'})`} value={`${summary.passB}/${summary.total}`} />
        <Stat label="쓰임 라벨 바뀐 문장" value={String(summary.usageLabelChanged)} />
      </div>

      <ul className="flex flex-col gap-2">
        {shownKeys.map((key) => {
          const a = latestA.get(key);
          const b = latestB.get(key);
          const fields = compareOutputs(a?.output, b?.output);
          return (
            <li key={key} className="rounded-2xl border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-sm font-medium">{sentenceFor(key)}</p>
              <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
                <RunBadge run={a} label="A" />
                <RunBadge run={b} label="B" />
              </div>
              <dl className="mt-2 flex flex-col gap-1 text-xs">
                {fields.map((f) => (
                  <div key={f.key} className={`grid grid-cols-[4.5rem_1fr_1fr] gap-2 rounded px-1 ${f.changed ? 'bg-amber-50 dark:bg-amber-950/40' : ''}`}>
                    <dt className="text-slate-400">{f.label}</dt>
                    <dd className="break-words">{f.a || '—'}</dd>
                    <dd className={`break-words ${f.changed ? 'font-semibold' : ''}`}>{f.b || '—'}</dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>

      {versionB?.status === 'draft' && gate && (
        <div className="flex flex-col gap-2 rounded-2xl border border-blue-200 p-3 dark:border-blue-800">
          <p className="text-sm font-medium">v{versionB.version_no} 활성화</p>
          <p className={`text-xs ${gate.ready ? 'text-green-600' : 'text-slate-500'}`}>
            테스트 세트 통과 {gate.passed}/{gate.total} (마지막 수정 이후 실행분만) — {gate.ready ? '활성화 가능' : '전체 통과해야 활성화할 수 있습니다'}
          </p>
          <input
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
            placeholder="변경 이유 (필수)"
            className="w-full rounded-lg border border-slate-300 bg-transparent p-2 text-sm dark:border-slate-700"
          />
          <button
            disabled={!gate.ready || !changeNote.trim() || activating}
            onClick={async () => {
              setActivating(true);
              try {
                await adminPrompts.activate(versionB.id, changeNote.trim());
                onActivated(versionB.version_no);
              } catch (err) {
                onError(`활성화 거부: ${errorText(err)}`);
              } finally {
                setActivating(false);
              }
            }}
            className="rounded-full bg-green-600 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {activating ? '활성화 중...' : '활성화'}
          </button>
        </div>
      )}
    </div>
  );
}

function VersionSelect({ label, value, onChange, versions }: { label: string; value: string; onChange: (v: string) => void; versions: PromptVersion[] }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-slate-400">버전 {label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700">
        <option value="">선택</option>
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            v{v.version_no} ({STATUS_LABEL[v.status]})
          </option>
        ))}
      </select>
    </label>
  );
}

function RunBadge({ run, label }: { run: PromptTestRun | undefined; label: string }) {
  if (!run) return <span className="text-slate-400">{label}: 미실행</span>;
  return (
    <span className={run.valid ? 'text-green-600' : 'text-red-500'}>
      {label}: {run.valid ? '✓ 통과' : `✗ ${run.error ?? '실패'}`}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-900">
      <p className="text-lg font-semibold">{value}</p>
      <p className="text-slate-400">{label}</p>
    </div>
  );
}

function TextDiff({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const lines = diffLines(before, after);
  const changed = lines.filter((l) => l.type !== 'same').length;
  return (
    <div className="mt-2 rounded-xl border border-slate-200 p-2 dark:border-slate-800">
      <p className="mb-1 text-xs text-slate-400">
        <span className="text-red-500">− {beforeLabel}</span> / <span className="text-green-600">+ {afterLabel}</span> · 바뀐 줄 {changed}
      </p>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
        {lines.map((l, i) => (
          <div
            key={i}
            className={
              l.type === 'added'
                ? 'bg-green-50 text-green-800 dark:bg-green-950/50 dark:text-green-300'
                : l.type === 'removed'
                  ? 'bg-red-50 text-red-700 line-through dark:bg-red-950/50 dark:text-red-300'
                  : 'text-slate-500'
            }
          >
            {l.type === 'added' ? '+ ' : l.type === 'removed' ? '− ' : '  '}
            {l.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}
