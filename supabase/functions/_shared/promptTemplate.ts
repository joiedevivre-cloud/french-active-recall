// Pure template logic for DB-managed prompts (prompt_versions, migration
// 0018). No Deno/Node APIs -- imported by the Edge Functions, the backfill
// script and Vitest alike.
//
// A stored prompt = editable `instructions` (may contain {{variable}}
// placeholders filled from `settings`) + a LOCKED output contract that
// lives in code and is always appended after the instructions. The admin
// screen can never edit the contract, so the JSON shape the code parses
// (and the usage-reuse rules the code depends on) cannot be broken from
// the UI.

export type TargetLevel = 'A2' | 'B1' | 'B2';
export type GrammarDepth = 'brief' | 'standard' | 'detailed';

export interface PromptSettings {
  target_level: TargetLevel;
  grammar_depth: GrammarDepth;
  examples_per_usage: number;
  expand_related_grammar: boolean;
  related_grammar_max: number;
}

/**
 * Defaults per the spec. Stage 1 only uses them for {{variable}}
 * substitution (v1's instructions reference none of them); stage 2 wires
 * them into the output contract (usage.examples, grammar_points[].related).
 */
export const DEFAULT_PROMPT_SETTINGS: PromptSettings = {
  target_level: 'B1',
  grammar_depth: 'standard',
  examples_per_usage: 1,
  expand_related_grammar: false,
  related_grammar_max: 2,
};

export const AVAILABLE_VARIABLES = Object.keys(DEFAULT_PROMPT_SETTINGS) as (keyof PromptSettings)[];

const VARIABLE_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Every {{name}} used in the text (unique, in order of first use). */
export function findTemplateVariables(instructions: string): string[] {
  const seen = new Set<string>();
  for (const m of instructions.matchAll(VARIABLE_RE)) seen.add(m[1]);
  return [...seen];
}

export interface TemplateCheck {
  unknownVariables: string[];
  /** "{{" or "}}" that is not part of a well-formed {{name}} placeholder. */
  malformed: boolean;
}

export function checkTemplate(instructions: string): TemplateCheck {
  const unknownVariables = findTemplateVariables(instructions).filter((v) => !(AVAILABLE_VARIABLES as string[]).includes(v));
  const stripped = instructions.replace(VARIABLE_RE, '');
  return { unknownVariables, malformed: stripped.includes('{{') || stripped.includes('}}') };
}

/** Merges stored settings over the defaults, dropping unknown keys and invalid values. */
export function normalizeSettings(raw: unknown): PromptSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PROMPT_SETTINGS;
  const intIn = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  return {
    target_level: s.target_level === 'A2' || s.target_level === 'B1' || s.target_level === 'B2' ? s.target_level : d.target_level,
    grammar_depth: s.grammar_depth === 'brief' || s.grammar_depth === 'standard' || s.grammar_depth === 'detailed' ? s.grammar_depth : d.grammar_depth,
    examples_per_usage: intIn(s.examples_per_usage, 0, 3, d.examples_per_usage),
    expand_related_grammar: typeof s.expand_related_grammar === 'boolean' ? s.expand_related_grammar : d.expand_related_grammar,
    related_grammar_max: intIn(s.related_grammar_max, 1, 3, d.related_grammar_max),
  };
}

/** Lists settings problems for the save endpoint (normalizeSettings silently repairs; saving must not). */
export function validateSettings(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return ['settings must be an object'];
  const errors: string[] = [];
  const normalized = normalizeSettings(raw) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(AVAILABLE_VARIABLES as string[]).includes(key)) errors.push(`unknown setting: ${key}`);
    else if (normalized[key] !== value) errors.push(`invalid value for ${key}`);
  }
  return errors;
}

/** Replaces {{name}} with the setting's value. Throws on an unknown/malformed placeholder. */
export function renderInstructions(instructions: string, settings: PromptSettings): string {
  const check = checkTemplate(instructions);
  if (check.unknownVariables.length > 0) throw new Error(`unknown_template_variables: ${check.unknownVariables.join(', ')}`);
  if (check.malformed) throw new Error('malformed_template_placeholder');
  return instructions.replace(VARIABLE_RE, (_, name: keyof PromptSettings) => String(settings[name]));
}

/** Final system prompt: rendered (editable) instructions, then the locked output contract. */
export function composeSystemPrompt(renderedInstructions: string, outputContract: string): string {
  return `${renderedInstructions.trim()}\n\n${outputContract.trim()}`;
}

/** The version's model is used only if this user's ai_rate_limits allows it -- the server keeps the final say over models. */
export function pickAllowedModel(versionModel: string | null | undefined, allowedModels: string[] | null | undefined): string {
  const allowed = allowedModels && allowedModels.length > 0 ? allowedModels : ['gpt-4o-mini'];
  return versionModel && allowed.includes(versionModel) ? versionModel : allowed[0];
}

export function isValidTemperature(t: unknown): boolean {
  return t === null || t === undefined || (typeof t === 'number' && t >= 0 && t <= 2);
}
