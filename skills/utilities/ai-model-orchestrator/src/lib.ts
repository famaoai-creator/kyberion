export interface AIModel {
  id: string;
  provider: string;
  tier: 'economy' | 'balanced' | 'premium';
  costPer1kTokens: number;
  maxContext: number;
  strengths: string[];
  latencyMs: number;
  capabilities: string[];
}

export const MODEL_CATALOG: AIModel[] = [
  {
    id: 'gemini-2.0-flash',
    provider: 'google',
    tier: 'economy',
    costPer1kTokens: 0.0001,
    maxContext: 1000000,
    strengths: ['speed', 'cost', 'long-context'],
    latencyMs: 200,
    capabilities: ['text', 'code', 'analysis'],
  },
  {
    id: 'gemini-2.0-pro',
    provider: 'google',
    tier: 'balanced',
    costPer1kTokens: 0.005,
    maxContext: 2000000,
    strengths: ['reasoning', 'long-context', 'multimodal'],
    latencyMs: 1000,
    capabilities: ['text', 'code', 'analysis', 'reasoning', 'multimodal'],
  },
];

export interface TaskComplexity {
  hardness: 'low' | 'medium' | 'high';
  requiredCapabilities: string[];
  wordCount: number;
  estimatedTokens: number;
}

export function analyzeTaskComplexity(content: string): TaskComplexity {
  const wordCount = content.split(/\s+/).length;
  // 文字列ベースの簡易チェック (Libではより広いパターンを許容)
  const isCode = /implement|write|create|build|develop|function|api/i.test(content);
  const isReasoning = /why|explain|analyze|compare|evaluate|design|architect/i.test(content);

  let hardness: TaskComplexity['hardness'] = 'low';
  const requiredCapabilities = ['text'];

  if (isCode) {
    hardness = 'medium';
    requiredCapabilities.push('code');
  }
  if (isReasoning) {
    hardness = 'high';
    requiredCapabilities.push('reasoning');
  }

  return {
    hardness,
    requiredCapabilities: [...new Set(requiredCapabilities)],
    wordCount,
    estimatedTokens: Math.round(wordCount * 1.3),
  };
}

export function selectModel(
  complexity: TaskComplexity,
  budget: 'economy' | 'balanced' | 'premium'
): AIModel {
  const budgetFilter = {
    economy: ['economy'],
    balanced: ['economy', 'balanced'],
    premium: ['economy', 'balanced', 'premium'],
  };
  const allowedTiers = budgetFilter[budget];

  const candidates = MODEL_CATALOG.filter((m) => allowedTiers.includes(m.tier))
    .filter((m) => complexity.requiredCapabilities.every((cap) => m.capabilities.includes(cap)))
    .filter((m) => m.maxContext >= complexity.estimatedTokens);

  if (candidates.length === 0) {
    return MODEL_CATALOG[MODEL_CATALOG.length - 1];
  }

  return candidates[0];
}
