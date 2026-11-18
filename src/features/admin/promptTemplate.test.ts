import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_VARIABLES,
  DEFAULT_PROMPT_SETTINGS,
  checkTemplate,
  composeSystemPrompt,
  findTemplateVariables,
  isValidTemperature,
  normalizeSettings,
  pickAllowedModel,
  renderInstructions,
  validateSettings,
} from '../../../supabase/functions/_shared/promptTemplate';

describe('{{variable}} templates', () => {
  it('finds variables (deduplicated, spaces allowed)', () => {
    expect(findTemplateVariables('Level {{target_level}}, again {{ target_level }} and {{grammar_depth}}')).toEqual(['target_level', 'grammar_depth']);
  });

  it('rejects unknown variables on save', () => {
    expect(checkTemplate('Explain for {{learner_name}} at {{target_level}}').unknownVariables).toEqual(['learner_name']);
  });

  it('flags malformed placeholders', () => {
    expect(checkTemplate('broken {{target_level').malformed).toBe(true);
    expect(checkTemplate('fine {{target_level}}').malformed).toBe(false);
  });

  it('renders settings values and throws on an unknown variable', () => {
    expect(renderInstructions('Level: {{target_level}}, depth: {{grammar_depth}}', DEFAULT_PROMPT_SETTINGS)).toBe('Level: B1, depth: standard');
    expect(() => renderInstructions('{{nope}}', DEFAULT_PROMPT_SETTINGS)).toThrow(/unknown_template_variables/);
  });

  it('exposes exactly the settings keys as variables', () => {
    expect(AVAILABLE_VARIABLES).toEqual(['target_level', 'grammar_depth', 'examples_per_usage', 'expand_related_grammar', 'related_grammar_max']);
  });
});

describe('settings', () => {
  it('normalizes missing/invalid values to defaults', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_PROMPT_SETTINGS);
    expect(normalizeSettings({ target_level: 'C2', examples_per_usage: 9 })).toEqual(DEFAULT_PROMPT_SETTINGS);
    expect(normalizeSettings({ target_level: 'B2' }).target_level).toBe('B2');
  });

  it('validateSettings reports unknown keys and bad values (save must not silently repair)', () => {
    expect(validateSettings(DEFAULT_PROMPT_SETTINGS)).toEqual([]);
    expect(validateSettings({ foo: 1 })).toEqual(['unknown setting: foo']);
    expect(validateSettings({ grammar_depth: 'huge' })).toEqual(['invalid value for grammar_depth']);
  });
});

describe('composition / model / temperature', () => {
  it('always appends the locked contract after the instructions', () => {
    expect(composeSystemPrompt('  INSTR \n', '\nCONTRACT')).toBe('INSTR\n\nCONTRACT');
  });

  it('uses the version model only when the user is allowed to use it', () => {
    expect(pickAllowedModel('gpt-4o', ['gpt-4o-mini', 'gpt-4o'])).toBe('gpt-4o');
    expect(pickAllowedModel('gpt-4o', ['gpt-4o-mini'])).toBe('gpt-4o-mini');
    expect(pickAllowedModel(null, null)).toBe('gpt-4o-mini');
  });

  it('accepts temperature null (= API default) or 0..2', () => {
    expect(isValidTemperature(null)).toBe(true);
    expect(isValidTemperature(0.2)).toBe(true);
    expect(isValidTemperature(3)).toBe(false);
    expect(isValidTemperature('1')).toBe(false);
  });
});
