#!/usr/bin/env node
/**
 * asset-token-economist: Analyzes text/code for token usage estimation.
 *
 * Uses character-based heuristics:
 *   - English prose: ~1 token per 4 characters
 *   - Code: ~1 token per 2.5 characters (more symbols/short identifiers)
 *   - Mixed: ~1 token per 3 characters
 *
 * Usage:
 *   node analyze.cjs --input <file>
 *   node analyze.cjs --text "some text to analyze"
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    description: 'Path to a file to analyze',
  })
  .option('text', {
    alias: 't',
    type: 'string',
    description: 'Raw text string to analyze',
  })
  .check((parsed) => {
    if (!parsed.input && !parsed.text) {
      throw new Error('You must provide either --input <file> or --text <string>');
    }
    return true;
  })
  .help().argv;

// --- Pricing per 1K tokens (USD, approximate as of 2024-2025) ---
const PRICING = {
  gpt4: { input: 0.03, output: 0.06 },
  'gpt4-turbo': { input: 0.01, output: 0.03 },
  claude: { input: 0.015, output: 0.075 },
  'claude-haiku': { input: 0.00025, output: 0.00125 },
};

/**
 * Detect whether content is predominantly code, prose, or mixed.
 * @param {string} text
 * @returns {'code'|'prose'|'mixed'}
 */
function detectContentType(text) {
  const lines = text.split('\n');
  const totalLines = lines.length;
  if (totalLines === 0) return 'prose';

  let codeSignals = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Code signals: braces, semicolons, arrows, imports, keywords
    if (
      /[{};]/.test(trimmed) ||
      /^\s*(import|export|const|let|var|function|class|def|public|private|if|for|while|return)\b/.test(
        trimmed
      ) ||
      /^\s*(#include|#define|#ifdef|package |using )/.test(trimmed) ||
      /=>/.test(trimmed) ||
      /^\s*\/\//.test(trimmed) ||
      /^\s*#(?!\s)/.test(trimmed)
    ) {
      codeSignals++;
    }
  }

  const codeRatio = codeSignals / totalLines;
  if (codeRatio > 0.5) return 'code';
  if (codeRatio > 0.15) return 'mixed';
  return 'prose';
}

/**
 * Estimate token count based on character length and content type.
 * @param {string} text
 * @param {'code'|'prose'|'mixed'} contentType
 * @returns {number}
 */
function estimateTokens(text, contentType) {
  const charCount = text.length;
  const charsPerToken = {
    prose: 4,
    code: 2.5,
    mixed: 3,
  };
  return Math.ceil(charCount / charsPerToken[contentType]);
}

/**
 * Compute cost estimates for various models.
 * @param {number} tokens
 * @returns {Object}
 */
function computeCosts(tokens) {
  const costs = {};
  for (const [model, rates] of Object.entries(PRICING)) {
    costs[model] = {
      inputCost: parseFloat(((tokens / 1000) * rates.input).toFixed(6)),
      outputCostPer1kGenerated: rates.output,
    };
  }
  return costs;
}

/**
 * Generate optimization recommendations.
 * @param {number} charCount
 * @param {number} estimatedTokens
 * @param {'code'|'prose'|'mixed'} contentType
 * @param {number} lineCount
 * @returns {string[]}
 */
function generateRecommendations(charCount, estimatedTokens, contentType, lineCount) {
  const recommendations = [];

  if (estimatedTokens > 100000) {
    recommendations.push(
      'Token count exceeds 100K. Consider chunking the input or using a summarization step first.'
    );
  }

  if (estimatedTokens > 30000) {
    recommendations.push(
      'Large input detected. Use claude-haiku or gpt4-turbo for cost-efficient processing of bulk content.'
    );
  }

  if (contentType === 'code' && lineCount > 500) {
    recommendations.push(
      'Large code file. Consider extracting only relevant functions/classes instead of sending the entire file.'
    );
  }

  if (contentType === 'prose' && charCount > 50000) {
    recommendations.push(
      'Long prose document. Consider summarizing or extracting key sections before sending to the model.'
    );
  }

  if (estimatedTokens < 500) {
    recommendations.push('Input is small enough for any model tier without cost concerns.');
  }

  if (recommendations.length === 0) {
    recommendations.push('Input size is within typical limits. No special optimization needed.');
  }

  return recommendations;
}

runSkill('asset-token-economist', () => {
  let text;
  let sourceName;

  if (argv.input) {
    const resolved = path.resolve(argv.input);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    if (!fs.statSync(resolved).isFile()) {
      throw new Error(`Not a file: ${resolved}`);
    }
    text = fs.readFileSync(resolved, 'utf8');
    sourceName = path.basename(resolved);
  } else {
    text = argv.text;
    sourceName = '<inline-text>';
  }

  const inputChars = text.length;
  const lineCount = text.split('\n').length;
  const contentType = detectContentType(text);
  const estimatedTokens = estimateTokens(text, contentType);
  const costEstimate = computeCosts(estimatedTokens);
  const recommendations = generateRecommendations(
    inputChars,
    estimatedTokens,
    contentType,
    lineCount
  );

  return {
    source: sourceName,
    inputChars,
    lineCount,
    contentType,
    estimatedTokens,
    costEstimate,
    recommendations,
  };
});
