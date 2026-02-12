#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
/**
 * ai-model-orchestrator: Analyzes task complexity and selects optimal AI model.
 * Routes to appropriate model based on cost, latency, and capability requirements.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to JSON task description or text prompt file',
  })
  .option('budget', {
    alias: 'b',
    type: 'string',
    default: 'balanced',
    choices: ['economy', 'balanced', 'premium'],
    description: 'Cost tier preference',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help()
  .argv;

const MODEL_CATALOG = [
  { id: 'gemini-2.0-flash', provider: 'google', tier: 'economy', costPer1kTokens: 0.0001, maxContext: 1000000, strengths: ['speed', 'cost', 'long-context'], latencyMs: 200, capabilities: ['text', 'code', 'analysis'] },
  { id: 'gemini-2.0-pro', provider: 'google', tier: 'balanced', costPer1kTokens: 0.005, maxContext: 2000000, strengths: ['reasoning', 'long-context', 'multimodal'], latencyMs: 1000, capabilities: ['text', 'code', 'analysis', 'reasoning', 'multimodal'] },
  { id: 'claude-sonnet-4-5', provider: 'anthropic', tier: 'balanced', costPer1kTokens: 0.003, maxContext: 200000, strengths: ['code', 'analysis', 'safety'], latencyMs: 800, capabilities: ['text', 'code', 'analysis', 'reasoning'] },
  { id: 'claude-opus-4', provider: 'anthropic', tier: 'premium', costPer1kTokens: 0.015, maxContext: 200000, strengths: ['reasoning', 'code', 'creative', 'safety'], latencyMs: 2000, capabilities: ['text', 'code', 'analysis', 'reasoning', 'creative'] },
  { id: 'gpt-4o', provider: 'openai', tier: 'balanced', costPer1kTokens: 0.005, maxContext: 128000, strengths: ['general', 'multimodal', 'function-calling'], latencyMs: 1000, capabilities: ['text', 'code', 'analysis', 'multimodal', 'function-calling'] },
  { id: 'gpt-4o-mini', provider: 'openai', tier: 'economy', costPer1kTokens: 0.00015, maxContext: 128000, strengths: ['speed', 'cost', 'function-calling'], latencyMs: 300, capabilities: ['text', 'code', 'analysis', 'function-calling'] },
  { id: 'llama-3.1-70b', provider: 'local', tier: 'economy', costPer1kTokens: 0, maxContext: 128000, strengths: ['privacy', 'cost', 'customizable'], latencyMs: 500, capabilities: ['text', 'code', 'analysis'] },
  { id: 'deepseek-v3', provider: 'deepseek', tier: 'economy', costPer1kTokens: 0.0002, maxContext: 128000, strengths: ['code', 'cost', 'reasoning'], latencyMs: 400, capabilities: ['text', 'code', 'analysis', 'reasoning'] },
];

function analyzeTaskComplexity(content) {
  const _lower = content.toLowerCase();
  const wordCount = content.split(/\s+/).length;

  const complexitySignals = {
    codeGeneration: /(?:implement|write|create|build|develop)\s+(?:a |an |the )?(?:function|class|module|service|api)/i.test(content),
    reasoning: /(?:why|explain|analyze|compare|evaluate|design|architect)/i.test(content),
    creative: /(?:draft|write|compose|create|generate)\s+(?:a |an |the )?(?:story|blog|email|proposal|narrative)/i.test(content),
    multimodal: /(?:image|photo|diagram|chart|screenshot|video|audio)/i.test(content),
    security: /(?:security|vulnerability|exploit|penetration|audit|compliance)/i.test(content),
    longContext: wordCount > 5000 || /(?:entire|whole|complete|all of|full)/i.test(content),
    simple: wordCount < 50 && !/(?:explain|analyze|design|architect|compare)/i.test(content),
  };

  let hardness = 'low';
  const requiredCapabilities = ['text'];
  if (complexitySignals.codeGeneration) { hardness = 'medium'; requiredCapabilities.push('code'); }
  if (complexitySignals.reasoning) { hardness = 'high'; requiredCapabilities.push('reasoning'); }
  if (complexitySignals.creative) { requiredCapabilities.push('creative'); }
  if (complexitySignals.multimodal) { requiredCapabilities.push('multimodal'); }
  if (complexitySignals.security) { hardness = 'high'; requiredCapabilities.push('reasoning'); }
  if (complexitySignals.longContext) { hardness = hardness === 'low' ? 'medium' : hardness; }
  if (complexitySignals.simple) { hardness = 'low'; }

  return { hardness, requiredCapabilities: [...new Set(requiredCapabilities)], signals: complexitySignals, wordCount, estimatedTokens: Math.round(wordCount * 1.3) };
}

function selectModel(complexity, budget) {
  const budgetFilter = {
    economy: ['economy'],
    balanced: ['economy', 'balanced'],
    premium: ['economy', 'balanced', 'premium'],
  };
  const allowedTiers = budgetFilter[budget];

  const candidates = MODEL_CATALOG
    .filter(m => allowedTiers.includes(m.tier))
    .filter(m => complexity.requiredCapabilities.every(cap => m.capabilities.includes(cap)))
    .filter(m => m.maxContext >= complexity.estimatedTokens);

  if (candidates.length === 0) {
    return { primary: MODEL_CATALOG.find(m => m.tier === 'premium'), fallbacks: [], reason: 'No model matches all requirements; falling back to premium' };
  }

  // Score candidates
  const scored = candidates.map(m => {
    let score = 0;
    if (complexity.hardness === 'low') score += m.tier === 'economy' ? 10 : 0;
    if (complexity.hardness === 'high') score += m.tier === 'premium' ? 10 : m.tier === 'balanced' ? 5 : 0;
    score += m.capabilities.length;
    score -= m.costPer1kTokens * 100;
    if (complexity.signals.longContext) score += m.maxContext > 500000 ? 5 : 0;
    return { model: m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return {
    primary: scored[0].model,
    fallbacks: scored.slice(1, 3).map(s => s.model),
    reason: `Selected based on ${complexity.hardness} complexity, ${budget} budget, requires: ${complexity.requiredCapabilities.join(', ')}`,
  };
}

runSkill('ai-model-orchestrator', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);

  const content = fs.readFileSync(resolved, 'utf8');
  let taskContent = content;
  try {
    const json = JSON.parse(content);
    taskContent = json.prompt || json.task || json.description || content;
  } catch (_e) { /* plain text */ }

  const complexity = analyzeTaskComplexity(taskContent);
  const selection = selectModel(complexity, argv.budget);
  const estimatedCost = selection.primary.costPer1kTokens * (complexity.estimatedTokens / 1000) * 2;

  const result = {
    source: path.basename(resolved),
    budget: argv.budget,
    taskAnalysis: complexity,
    selectedModel: {
      id: selection.primary.id,
      provider: selection.primary.provider,
      tier: selection.primary.tier,
      estimatedCostUSD: Math.round(estimatedCost * 10000) / 10000,
      estimatedLatencyMs: selection.primary.latencyMs,
      maxContext: selection.primary.maxContext,
    },
    fallbackModels: selection.fallbacks.map(m => ({ id: m.id, provider: m.provider, tier: m.tier })),
    selectionReason: selection.reason,
    availableModels: MODEL_CATALOG.length,
  };

  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
