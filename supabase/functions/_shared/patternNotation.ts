// Standard notation for usage patterns (lemma_usages.pattern).
//
// The AI writes the same construction many ways:
//   "se confier à + groupe nominal (personne)"  vs  "se confier à + nom (사람)"
// Comparing those as different strings is what created the duplicate
// "의탁하다" usage for confier. So patterns are converted to ONE notation
// BEFORE they are stored (classify + seed_dictionary) and before they are
// compared:
//   person  -> qqn      thing -> qqch      infinitive -> inf.
//   clause  -> proposition
// "+" is dropped before/after qqn/qqch (dictionary style: "confier qqch à
// qqn") and kept before inf./proposition ("se mettre à + inf.").
// Qualifiers that carry meaning are kept: "chercher + groupe nominal
// (emploi)" -> "chercher qqch (emploi)" -- two senses that differ only by
// such a qualifier must stay distinct usages.
//
// Pure, no Deno APIs: also imported by Vitest (src/features/vocabulary/patternNotation.test.ts).

const NOMINAL = String.raw`(?:groupe nominal|groupe nom|nom propre|nom commun|nom|gn|sn|pronom|complement d'objet direct|complement d objet direct|cod|coi)`;
const PERSON_Q = String.raw`(?:une personne|personnes|personne|qqn|qn|quelqu'un|사람|인물|누군가)`;
const THING_Q = String.raw`(?:choses|chose|objets|objet|qqch|qch|quelque chose|사물|물건|것)`;

function stripAccentsLower(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase(); // NFC again so Hangul recomposes
}

const RULES: [RegExp, string][] = [
  // nominal + person/thing qualifier
  [new RegExp(String.raw`\b${NOMINAL}\s*\(\s*${PERSON_Q}\s*\)`, 'g'), 'qqn'],
  [new RegExp(String.raw`\b${NOMINAL}\s*\(\s*${THING_Q}\s*\)`, 'g'), 'qqch'],
  // spelled-out / abbreviated person & thing
  [/\bquelqu'?\s?un\b/g, 'qqn'],
  [/\bqn\b/g, 'qqn'],
  [/\bquelque chose\b/g, 'qqch'],
  [/\bqch\b/g, 'qqch'],
  [/\bqqc\b/g, 'qqch'],
  // infinitive (any qualifier dropped: "infinitif (행동)" -> "inf.")
  [/\b(?:verbe a l'infinitif|verbe a l infinitif|infinitif|inf)\b\.?(?:\s*\([^)]*\))?/g, 'inf.'],
  // clause
  [/(?:주어\s*\+\s*동사|sujet\s*\+\s*verbe|proposition subordonnee|proposition|subordonnee)(?:\s*\([^)]*\))?/g, 'proposition'],
];

/** A whole "+"-segment that is just a nominal slot, e.g. "nom" or "groupe nominal (emploi)". */
const BARE_NOMINAL_SEGMENT = new RegExp(String.raw`^${NOMINAL}(\s*\([^)]*\))?$`);

/** Applies one regex to the accent-free copy and splices replacements into the original (same length, NFC). */
function replaceFolded(s: string, re: RegExp, replacement: string): string {
  const folded = stripAccentsLower(s);
  if (folded.length !== s.length) return s; // unexpected length change -- leave untouched
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out += s.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
  }
  return out + s.slice(last);
}

/**
 * Converts a pattern to the standard notation. The French words themselves
 * keep their accents (placeholders are matched accent-insensitively), so
 * "se confier à + nom (사람)" -> "se confier à qqn". Idempotent.
 */
export function canonicalizePattern(pattern: string): string {
  let s = pattern.normalize('NFC').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
  if (!s) return s;
  for (const [re, replacement] of RULES) s = replaceFolded(s, re, replacement);

  const parts = s
    .split(/\s*\+\s*/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const m = BARE_NOMINAL_SEGMENT.exec(stripAccentsLower(part));
      if (!m) return part;
      const qualifier = m[1] ? part.slice(part.length - m[1].length).trim() : '';
      return qualifier ? `qqch ${qualifier}` : 'qqch';
    });

  // Re-join: drop "+" around qqn/qqch, keep it before inf./proposition.
  let joined = parts[0] ?? '';
  for (let i = 1; i < parts.length; i++) {
    joined += /^(inf\.|proposition)/.test(parts[i]) ? ` + ${parts[i]}` : ` ${parts[i]}`;
  }
  return joined.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

/**
 * English-calque constructions that are not French. Checked in code so a
 * bad sense is blocked even if the AI self-check misses it.
 *   "confier qqn avec qqch" (= entrust A with B) -> not French.
 */
const CALQUE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\bqqn avec qqch\b/, reason: '영어식 구문(entrust/provide A with B)이에요. 프랑스어에서는 이렇게 쓰지 않아요.' },
];

export function calqueReason(canonicalPattern: string): string | null {
  const p = stripAccentsLower(canonicalPattern);
  return CALQUE_PATTERNS.find((c) => c.re.test(p))?.reason ?? null;
}
