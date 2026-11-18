import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  buildVocabularyIndex,
  type ExpressionRecord,
  type LemmaRecord,
  type LinkRecord,
  type ReviewRecord,
  type UsageRecord,
} from '@/features/vocabulary/vocabularyIndex';

export const VOCABULARY_QUERY_KEY = 'vocabulary-data';

export interface VocabularyData {
  lemmas: LemmaRecord[];
  usages: UsageRecord[];
  links: LinkRecord[];
  expressions: ExpressionRecord[];
  reviews: ReviewRecord[];
}

/**
 * Loads everything the 단어장 list/detail and home search need in one
 * query (5 small selects, all RLS-scoped to the signed-in user). Read-only
 * -- no AI calls. lemmas uses select('*') so the screen keeps working both
 * before and after migration 0019 adds forms / is_favorite / status.
 */
export function useVocabularyData() {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: [VOCABULARY_QUERY_KEY, user?.id],
    enabled: !!user,
    queryFn: async (): Promise<VocabularyData> => {
      const [lemmas, usages, links, expressions, reviews] = await Promise.all([
        supabase.from('lemmas').select('*').eq('user_id', user!.id),
        supabase.from('lemma_usages').select('id, lemma_id, label, meaning_ko, pattern, sort_order, source').eq('user_id', user!.id),
        supabase.from('expression_analysis').select('expression_id, lemma_id, usage_id').eq('user_id', user!.id),
        supabase.from('expressions').select('id, expression_fr, meaning_ko').eq('user_id', user!.id).is('deleted_at', null),
        supabase.from('review_states').select('expression_id, lemma_usage_id, due_at, lapses').eq('user_id', user!.id),
      ]);
      for (const r of [lemmas, usages, links, expressions, reviews]) if (r.error) throw r.error;
      return {
        lemmas: (lemmas.data ?? []) as LemmaRecord[],
        usages: (usages.data ?? []) as UsageRecord[],
        links: (links.data ?? []) as LinkRecord[],
        expressions: (expressions.data ?? []) as ExpressionRecord[],
        reviews: (reviews.data ?? []) as ReviewRecord[],
      };
    },
  });

  const entries = useMemo(() => (query.data ? buildVocabularyIndex(query.data) : []), [query.data]);
  return { ...query, entries };
}
