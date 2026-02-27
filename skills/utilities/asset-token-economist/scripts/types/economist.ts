/**
 * Type definitions for the asset-token-economist skill.
 *
 * The asset-token-economist analyzes text or code content and produces token count
 * estimates, per-model cost projections, and optimization recommendations
 * based on character-level heuristics.
 *
 * Usage:
 *   import type { EconomistResult, EconomistConfig } from './types/economist.js';
 */

import type { SkillOutput } from '@agent/core/types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** CLI arguments accepted by the asset-token-economist skill. */
export interface EconomistConfig {
  /** Path to a file to analyze. */
  input?: string;
  /** Raw text string to analyze (alternative to --input). */
  text?: string;
}

// ---------------------------------------------------------------------------
// Content Classification
// ---------------------------------------------------------------------------

/** Detected content type used to select the asset-token-estimation ratio. */
export type ContentType = 'code' | 'prose' | 'mixed';

// ---------------------------------------------------------------------------
// Cost Estimates
// ---------------------------------------------------------------------------

/** Per-model cost breakdown for estimated token count. */
export interface ModelCost {
  /** Estimated cost in USD to send the tokens as input. */
  inputCost: number;
  /** Model's output-token rate per 1K tokens generated (USD). */
  outputCostPer1kGenerated: number;
}

/** Map of model identifiers to their cost estimates. */
export interface CostEstimate {
  /** OpenAI GPT-4 pricing estimate. */
  gpt4: ModelCost;
  /** OpenAI GPT-4 Turbo pricing estimate. */
  'gpt4-turbo': ModelCost;
  /** Anthropic Claude pricing estimate. */
  claude: ModelCost;
  /** Anthropic Claude Haiku pricing estimate. */
  'claude-haiku': ModelCost;
}

// ---------------------------------------------------------------------------
// Skill Result
// ---------------------------------------------------------------------------

/** Full result data returned by the asset-token-economist skill. */
export interface EconomistResult {
  /** File name or "<inline-text>" indicating the analyzed source. */
  source: string;
  /** Total character count of the input content. */
  inputChars: number;
  /** Total number of lines in the input content. */
  lineCount: number;
  /** Detected content type (code, prose, or mixed). */
  contentType: ContentType;
  /** Estimated token count derived from character-based heuristics. */
  estimatedTokens: number;
  /** Per-model cost projections based on the estimated token count. */
  costEstimate: CostEstimate;
  /** Optimization recommendations for reducing token usage or cost. */
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Skill Output Envelope
// ---------------------------------------------------------------------------

/** Standard skill-wrapper envelope typed for the asset-token-economist result. */
export type TokenEconomistOutput = SkillOutput<EconomistResult>;
