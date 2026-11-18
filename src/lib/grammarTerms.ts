// Shared French grammar terminology dictionary (UI-side).
//
// Rule (README "프랑스어 문법 용어 표준화"): every grammar NAME / sentence
// component / construction rule is displayed with the French term the
// learner hears in class; Korean is only used for the meaning/explanation
// (and as a small gloss next to a term). Doing the term <-> gloss mapping
// here -- instead of asking the AI to emit both -- keeps the AI output
// smaller and means old analyses (written with Korean term names, before
// this rule existed) render correctly WITHOUT a re-analysis: toFrenchTerm()
// converts a legacy Korean label on the fly, and anything it doesn't know
// is returned unchanged (never breaks the screen).

export type RequiredComplement = 'nom' | 'pronom' | 'infinitif' | 'clause' | 'independent';
export type MoodRequirement = 'indicatif' | 'subjonctif' | 'conditionnel' | 'none';
export type Register = 'familier' | 'courant' | 'soutenu';

interface TermEntry {
  fr: string;
  ko: string;
  /** Korean (or loose French) spellings an older analysis may have used for this term. */
  aliases?: string[];
}

export const GRAMMAR_TERMS: TermEntry[] = [
  { fr: 'Groupe nominal (GN)', ko: '명사구', aliases: ['명사구', '명사', 'groupe nominal', 'GN'] },
  { fr: 'Pronom', ko: '대명사', aliases: ['대명사'] },
  { fr: 'Infinitif', ko: '동사원형', aliases: ['동사원형', '동사 원형', '부정사'] },
  { fr: 'Indicatif', ko: '직설법', aliases: ['직설법'] },
  { fr: 'Subjonctif', ko: '접속법', aliases: ['접속법'] },
  { fr: 'Conditionnel', ko: '조건법', aliases: ['조건법'] },
  { fr: 'Impératif', ko: '명령법', aliases: ['명령법'] },
  { fr: 'Proposition indépendante', ko: '독립절', aliases: ['독립절'] },
  { fr: 'Proposition principale', ko: '주절', aliases: ['주절'] },
  { fr: 'Proposition subordonnée', ko: '종속절', aliases: ['종속절'] },
  { fr: 'Proposition subordonnée complétive', ko: '보문절(que절)', aliases: ['보문절', '명사절'] },
  { fr: 'Proposition subordonnée relative', ko: '관계절', aliases: ['관계절'] },
  { fr: 'Conjonction de subordination', ko: '종속접속사', aliases: ['종속접속사', '접속사'] },
  { fr: 'Conjonction de coordination', ko: '등위접속사', aliases: ['등위접속사'] },
  { fr: 'Verbe pronominal', ko: '대명동사', aliases: ['대명동사', '재귀동사'] },
  { fr: 'Locution verbale', ko: '동사 관용구', aliases: ['동사구', '관용구', '숙어'] },
  { fr: 'Semi-auxiliaire', ko: '준조동사', aliases: ['준조동사', '반조동사'] },
  { fr: 'Auxiliaire', ko: '조동사', aliases: ['조동사'] },
  { fr: 'Participe passé', ko: '과거분사', aliases: ['과거분사'] },
  { fr: 'Accord du participe passé', ko: '과거분사 일치', aliases: ['과거분사 일치'] },
  { fr: 'Accord en genre et en nombre', ko: '성·수 일치', aliases: ['성·수 일치', '성수 일치', '성수일치', '성 일치'] },
  { fr: 'Préposition', ko: '전치사', aliases: ['전치사'] },
  { fr: 'Pronom relatif', ko: '관계대명사', aliases: ['관계대명사'] },
  { fr: 'Pronom personnel complément', ko: '목적보어 인칭대명사', aliases: ['목적대명사', '목적격 대명사'] },
  { fr: 'Pronom réfléchi', ko: '재귀대명사', aliases: ['재귀대명사'] },
  { fr: 'Complément d’objet direct (COD)', ko: '직접목적보어', aliases: ['직접목적어', '직접 목적어', 'COD'] },
  { fr: 'Complément d’objet indirect (COI)', ko: '간접목적보어', aliases: ['간접목적어', '간접 목적어', 'COI'] },
  { fr: 'Sujet', ko: '주어', aliases: ['주어'] },
  { fr: 'Verbe', ko: '동사', aliases: ['동사'] },
  { fr: 'Nom', ko: '명사' },
  { fr: 'Adjectif', ko: '형용사', aliases: ['형용사'] },
  { fr: 'Adverbe', ko: '부사', aliases: ['부사'] },
  { fr: 'Article', ko: '관사', aliases: ['관사'] },
  { fr: 'Déterminant', ko: '한정사', aliases: ['한정사'] },
  { fr: 'Conjonction', ko: '접속사' },
  { fr: 'Présent', ko: '현재', aliases: ['현재', '현재형'] },
  { fr: 'Passé composé', ko: '복합과거', aliases: ['복합과거', '복합 과거'] },
  { fr: 'Imparfait', ko: '반과거', aliases: ['반과거'] },
  { fr: 'Plus-que-parfait', ko: '대과거', aliases: ['대과거'] },
  { fr: 'Futur simple', ko: '단순미래', aliases: ['단순미래', '미래'] },
  { fr: 'Futur proche', ko: '근접미래', aliases: ['근접미래'] },
  { fr: 'Passé récent', ko: '근접과거', aliases: ['근접과거'] },
  { fr: 'Liaison', ko: '연음', aliases: ['연음'] },
  { fr: 'Enchaînement', ko: '연쇄 발음' },
  { fr: 'Élision', ko: '모음 생략', aliases: ['모음 생략', '축약'] },
  { fr: 'Voyelle nasale', ko: '비모음', aliases: ['비모음'] },
];

function normalizeKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .split('')
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < 0x300 || cp > 0x36f; // drop combining accents
    })
    .join('')
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ');
}

const byFrench = new Map<string, TermEntry>();
const byAlias = new Map<string, TermEntry>();
for (const entry of GRAMMAR_TERMS) {
  byFrench.set(normalizeKey(entry.fr), entry);
  for (const alias of entry.aliases ?? []) {
    const key = normalizeKey(alias);
    if (!byAlias.has(key)) byAlias.set(key, entry);
  }
}

/** Korean gloss for a French grammar term ("Subjonctif" -> "접속법"), or null if not in the dictionary. */
export function koGlossFor(frenchTerm: string | null | undefined): string | null {
  if (!frenchTerm) return null;
  return byFrench.get(normalizeKey(frenchTerm))?.ko ?? null;
}

/**
 * Converts a legacy Korean grammar label ("주절", "접속법") to its French
 * term. Unknown text (already French, or a full sentence) is returned
 * unchanged -- this is a display helper, so it must never lose content.
 */
export function toFrenchTerm(label: string | null | undefined): string {
  if (!label) return '';
  const key = normalizeKey(label);
  if (byFrench.has(key)) return byFrench.get(key)!.fr;
  return byAlias.get(key)?.fr ?? label;
}

/** "French term (한국어)" when a gloss is known, otherwise just the French/original text. */
export function termWithGloss(label: string | null | undefined): string {
  const fr = toFrenchTerm(label);
  const ko = koGlossFor(fr);
  return ko ? `${fr} (${ko})` : fr;
}

const COMPLEMENT_FR: Record<RequiredComplement, string> = {
  nom: 'groupe nominal (GN)',
  pronom: 'pronom',
  infinitif: 'infinitif',
  clause: 'proposition subordonnée',
  independent: 'proposition indépendante',
};

const CLAUSE_BY_MOOD_FR: Record<Exclude<MoodRequirement, 'none'>, string> = {
  indicatif: "proposition à l'indicatif",
  subjonctif: 'proposition au subjonctif',
  conditionnel: 'proposition au conditionnel',
};

const COMPLEMENT_KO: Record<string, string> = {
  'groupe nominal (GN)': '명사구',
  pronom: '대명사',
  infinitif: '동사원형',
  'proposition subordonnée': '종속절',
  'proposition indépendante': '독립절',
  "proposition à l'indicatif": '직설법 절',
  'proposition au subjonctif': '접속법 절',
  'proposition au conditionnel': '조건법 절',
};

/**
 * What must follow a construction, as the French label used in class:
 * ('nom') -> "groupe nominal (GN)", ('clause','subjonctif') -> "proposition
 * au subjonctif". Same enums as lemma_usages (migration 0016) and the
 * detailed analysis grammar_points (detailed-v3), so the vocabulary
 * screen and expression detail screen always print identical labels.
 */
export function complementLabelFr(complement: string | null | undefined, mood?: string | null): string | null {
  if (!complement || !(complement in COMPLEMENT_FR)) return null;
  if (complement === 'clause' && mood && mood !== 'none' && mood in CLAUSE_BY_MOOD_FR) {
    return CLAUSE_BY_MOOD_FR[mood as Exclude<MoodRequirement, 'none'>];
  }
  return COMPLEMENT_FR[complement as RequiredComplement];
}

export function complementLabelKo(complement: string | null | undefined, mood?: string | null): string | null {
  const fr = complementLabelFr(complement, mood);
  return fr ? COMPLEMENT_KO[fr] ?? null : null;
}

export const REGISTER_LABEL: Record<Register, string> = {
  familier: 'familier (구어)',
  courant: 'courant (일반)',
  soutenu: 'soutenu (격식)',
};

export function registerLabel(register: string | null | undefined): string | null {
  if (!register) return null;
  return REGISTER_LABEL[register as Register] ?? register;
}

/** Labels for the legacy sentence_structure rows -- French term first, Korean gloss second. */
export const SENTENCE_STRUCTURE_LABELS = {
  main_clause: { fr: 'Proposition principale', ko: '주절' },
  conjunction: { fr: 'Conjonction de subordination', ko: '접속사' },
  subordinate_clause: { fr: 'Proposition subordonnée', ko: '종속절' },
  core_structure: { fr: 'Construction', ko: '핵심 구조' },
  infinitive: { fr: 'Infinitif', ko: '동사원형' },
  conjugated_form: { fr: 'Forme conjuguée', ko: '활용형' },
} as const;

const POS_FR: Record<string, string> = {
  동사: 'verbe',
  명사: 'nom',
  '남성 명사': 'nom masculin',
  '여성 명사': 'nom féminin',
  형용사: 'adjectif',
  부사: 'adverbe',
  전치사: 'préposition',
  대명사: 'pronom',
  접속사: 'conjonction',
  관사: 'article',
  대명동사: 'verbe pronominal',
  관용구: 'locution',
  숙어: 'locution',
  표현: 'locution',
};

/** Part of speech in French ("동사" -> "verbe"); already-French or unknown values pass through unchanged. */
export function posLabel(pos: string | null | undefined): string {
  if (!pos) return '';
  return POS_FR[pos.trim()] ?? pos;
}

/**
 * Stable grammar_skills tag for a construction ("Se mettre à + infinitif"
 * -> "se_mettre_a_infinitif"), so practicing the same construction from
 * different screens/sentences accumulates on ONE grammar_skills row.
 */
export function grammarTagFromPattern(pattern: string): string {
  return normalizeKey(pattern)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}
