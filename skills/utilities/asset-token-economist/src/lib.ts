/**
 * Asset Token Economist Core Library.
 * Estimates token counts and costs based on character heuristics.
 */

export type ContentType = 'code' | 'prose' | 'mixed';

export interface ModelPricing {
  input_per_1k: number;
  output_per_1k: number;
}

const PRICING: Record<string, ModelPricing> = {
  gpt4: { input_per_1k: 0.03, output_per_1k: 0.06 },
  claude3: { input_per_1k: 0.015, output_per_1k: 0.075 },
  gemini15: { input_per_1k: 0.007, output_per_1k: 0.021 },
};

export function detectContentType(content: string): ContentType {
  const codeMarkers = [
    /import\s+.*from/i, /require\(.*/, /function\s+\w+\(/, /const\s+\w+\s*=/,
    /class\s+\w+/, /def\s+\w+\(/, /#include/, /package\s+/,
  ];
  const codeCount = codeMarkers.filter(m => m.test(content)).length;
  if (codeCount >= 2) return 'code';
  if (content.split('\n').length > 5 && content.includes('. ')) return 'prose';
  return 'mixed';
}

export function estimateTokens(content: string, type: ContentType): number {
  // Rough heuristics:
  // Prose: ~4 chars per token
  // Code: ~3 chars per token (due to symbols/indentation)
  const ratio = type === 'code' ? 3 : 4;
  return Math.ceil(content.length / ratio);
}

export function calculateCosts(tokens: number) {
  const costs: any = {};
  for (const [model, price] of Object.entries(PRICING)) {
    costs[model] = {
      inputCost: (tokens / 1000) * price.input_per_1k,
      outputCostPer1kGenerated: price.output_per_1k,
    };
  }
  return costs;
}

export function generateRecommendations(tokens: number, type: ContentType): string[] {
  const recs: string[] = [];
  if (tokens > 5000) {
    recs.push('Input is large. Consider summarizing or chunking.');
  }
  if (type === 'code' && tokens > 2000) {
    recs.push('Large code file. Strip comments and boilerplate to save tokens.');
  }
  return recs;
}

export function pruneContext(content: string, maxTokens: number, type: ContentType): string {
  const currentTokens = estimateTokens(content, type);
  if (currentTokens <= maxTokens) return content;

  // Simple truncation for now - more advanced logic could use sentence boundaries
  const ratio = type === 'code' ? 3 : 4;
  const targetChars = maxTokens * ratio;
  return content.substring(0, targetChars) + '\n... [TRUNCATED DUE TO TOKEN LIMIT] ...';
}
