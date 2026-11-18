import { analyzeSentencesInChunks, type BatchItemResult } from '@/features/ai-batch/aiBatchClient';
import { applyAnalysisResult, markAnalyzing } from '@/features/ai-batch/applyAnalysisResult';
import { analyzeLemmaBatch } from '@/features/vocabulary/lemmaClient';

export interface AnalyzableRow {
  expressionId: string;
  expressionFr: string;
  /**
   * false when the user already typed a meaning (paste "fr — ko", /ai-batch
   * results): the light meaning analysis is skipped for that row, but its
   * sentence/word analysis (analyze-lemma, 단어장) still runs. Defaults to true.
   */
  needsMeaning?: boolean;
}

/** Which saved rows get which analysis -- pure, see autoAnalyze.test.ts. */
export function planSaveAnalysis(rows: AnalyzableRow[]): { meaningRows: AnalyzableRow[]; lemmaExpressionIds: string[] } {
  const usable = rows.filter((r) => r.expressionFr.trim().length > 0);
  return {
    meaningRows: usable.filter((r) => r.needsMeaning !== false),
    lemmaExpressionIds: usable.map((r) => r.expressionId),
  };
}

/**
 * Runs the save-time AI analyses for freshly-saved expressions:
 * 1. light meaning analysis (analyze-batch) -- ONLY rows without a meaning
 *    yet, so a meaning the user already gave never costs an AI call;
 * 2. sentence/word analysis (analyze-lemma -> lemmas / lemma_usages /
 *    expression_analysis) -- EVERY saved row.
 *
 * Bug fixed here (2026-11-18): step 2 used to run only for rows without a
 * meaning, because it lived behind the same filter as step 1. Most saves
 * come with a meaning, so most expressions never reached the 단어장
 * (remote DB had 4 of 15 analyzed).
 *
 * The two run one after the other, never in parallel: both Edge Functions
 * hold the same 1-concurrent-request-per-user lock, so a parallel call
 * would just be rejected with concurrent_request_limit.
 */
export async function triggerAutoAnalysis(rows: AnalyzableRow[]): Promise<void> {
  const { meaningRows, lemmaExpressionIds } = planSaveAnalysis(rows);
  if (lemmaExpressionIds.length === 0) return;

  if (meaningRows.length > 0) {
    await markAnalyzing(meaningRows.map((r) => r.expressionId));
    const chunkResults = await analyzeSentencesInChunks(meaningRows.map((r) => r.expressionFr));

    const byText = new Map<string, BatchItemResult | null>();
    for (const chunk of chunkResults) {
      chunk.sentences.forEach((sentence, i) => {
        byText.set(sentence, chunk.status === 'success' ? chunk.results?.[i] ?? null : null);
      });
    }
    await Promise.all(meaningRows.map((row) => applyAnalysisResult(row.expressionId, byText.get(row.expressionFr) ?? null)));
  }

  // Separate feature, separate tables, separate cache (analyze-lemma skips
  // rows it already analyzed). Never allowed to fail the save flow.
  await analyzeLemmaBatch(lemmaExpressionIds).catch(() => undefined);
}
