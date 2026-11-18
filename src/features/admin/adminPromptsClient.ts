import { supabase } from '@/lib/supabase';
import type { PromptTestRun } from '@/features/admin/compareRuns';

export const PROMPT_KEY = 'sentence-analysis';

export interface PromptVersion {
  id: string;
  version_no: number;
  status: 'draft' | 'active' | 'archived';
  instructions: string;
  settings: Record<string, unknown>;
  model: string;
  temperature: number | null;
  change_note: string | null;
  based_on_version_id: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
}

export interface PromptTestCase {
  id: string;
  expression_fr: string;
  meaning_ko: string | null;
  note: string | null;
  expectations: Record<string, string>;
  sort_order: number;
}

export interface PromptOverview {
  promptKey: string;
  versions: PromptVersion[];
  testCases: PromptTestCase[];
  outputContract: string;
  defaultInstructions: string;
  availableVariables: string[];
  defaultSettings: Record<string, unknown>;
  allowedModels: string[];
}

export class AdminPromptsError extends Error {
  constructor(message: string, public status: number | null, public details: string[] = []) {
    super(message);
  }
}

/** Calls admin-prompts and unwraps the real HTTP status/body (supabase-js only gives a generic message). */
async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error, response } = await supabase.functions.invoke('admin-prompts', {
    body: { action, promptKey: PROMPT_KEY, ...payload },
  });
  if (error) {
    let message = error.message;
    let details: string[] = [];
    const status = response?.status ?? null;
    try {
      const body = await response?.clone().json();
      message = body?.message ?? body?.error ?? message;
      details = Array.isArray(body?.errors) ? body.errors : [];
    } catch {
      // body was not JSON -- keep the generic message
    }
    throw new AdminPromptsError(message, status, details);
  }
  if (!data?.ok) throw new AdminPromptsError(data?.error ?? 'invalid_response', null);
  return data as T;
}

export const adminPrompts = {
  overview: () => call<PromptOverview & { ok: true }>('overview'),
  runs: (versionId: string) => call<{ runs: PromptTestRun[] }>('runs', { versionId }).then((r) => r.runs),
  saveDraft: (input: {
    versionId?: string | null;
    instructions: string;
    settings: Record<string, unknown>;
    model: string;
    temperature: number | null;
    basedOnVersionId?: string | null;
  }) => call<{ version: { id: string; version_no: number; updated_at: string } }>('save_draft', input).then((r) => r.version),
  deleteDraft: (versionId: string) => call('delete_draft', { versionId }),
  restore: (versionId: string) =>
    call<{ version: { id: string; version_no: number }; restoredFrom: number }>('restore', { versionId }),
  preview: (versionId: string, target: { testCaseId: string } | { sentence: string }) =>
    call<{ run: PromptTestRun }>('preview', { versionId, ...target }).then((r) => r.run),
  activate: (versionId: string, changeNote: string) => call('activate', { versionId, changeNote }),
};

/** Runs async jobs with at most `limit` in flight (previews: 3, same as the other batch paths). */
export async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
