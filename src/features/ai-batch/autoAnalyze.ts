import { analyzeSentencesInChunks, type BatchItemResult } from '@/features/ai-batch/aiBatchClient';
import { applyAnalysisResult } from '@/features/ai-batch/applyAnalysisResult';

export interface AnalyzableRow {
  expressionId: string;
  expressionFr: string;
}

/**
 * Automatically analyzes freshly-saved expressions that have no meaning
 * yet (the paste-save flow never calls this for a row the user already
 * gave a meaning to -- re-analyzing it would be a wasted AI call for
 * something we already know). Uses the same batched Edge Function as
 * /ai-batch, so saving many expressions at once still costs one call per
 * ~15 of them, not one per expression.
 */
export async function triggerAutoAnalysis(rows: AnalyzableRow[]): Promise<void> {
  const toAnalyze = rows.filter((r) => r.expressionFr.trim().length > 0);
  if (toAnalyze.length === 0) return;

  const chunkResults = await analyzeSentencesInChunks(toAnalyze.map((r) => r.expressionFr));

  const byText = new Map<string, BatchItemResult | null>();
  for (const chunk of chunkResults) {
    chunk.sentences.forEach((sentence, i) => {
      byText.set(sentence, chunk.status === 'success' ? chunk.results?.[i] ?? null : null);
    });
  }

  await Promise.all(toAnalyze.map((row) => applyAnalysisResult(row.expressionId, byText.get(row.expressionFr) ?? null)));
}
