/**
 * Shared type definitions for Gemini Skills ecosystem.
 *
 * All TypeScript library modules import types from this file.
 * Import path: './types.js' (TypeScript resolves .js -> .ts under Node16 module resolution)
 */
/** Knowledge-tier hierarchy levels. */
export type TierLevel = 'personal' | 'confidential' | 'public';
/** Alias kept for backward compatibility with earlier type exports. */
export type KnowledgeTier = TierLevel;
/** Numeric weight map for tier comparison (higher = more sensitive). */
export type TierWeightMap = Record<TierLevel, number>;
/** Map of category name to an array of keyword strings used for matching. */
export type ClassifyRules = Record<string, string[]>;
/** Options accepted by the classify() function. */
export interface ClassifyOptions {
  /** Key name used for the result category field (default: 'category'). */
  resultKey?: string;
  /** Base confidence score when at least one match is found (default: 0.7). */
  baseConfidence?: number;
}
/** Result returned by classify(). The category key name is dynamic. */
export interface ClassifyResult {
  [resultKey: string]: string | number;
  confidence: number;
  matches: number;
}
/** Result of validateInjection() - checks tier data-flow legality. */
export interface TierValidation {
  allowed: boolean;
  sourceTier: TierLevel;
  outputTier: TierLevel;
  reason?: string;
}
/** Result of scanForConfidentialMarkers(). */
export interface MarkerScanResult {
  hasMarkers: boolean;
  markers: string[];
}
/** Result of input validation or schema validation. */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}
/** A single field-level validation error. */
export interface ValidationError {
  field: string;
  message: string;
}
/** Overall status of a skill execution. */
export type SkillStatus = 'success' | 'error' | 'partial';
/** Standard output envelope wrapping every skill execution result. */
export interface SkillOutput<T = unknown> {
  skill: string;
  status: SkillStatus;
  data?: T;
  metadata?: {
    duration_ms?: number;
    token_usage?: number;
    knowledge_tier_used?: KnowledgeTier;
    timestamp?: string;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
/** Standard input envelope for invoking a skill. */
export interface SkillInput {
  skill: string;
  action: string;
  params?: Record<string, unknown>;
  context?: {
    knowledge_tier?: KnowledgeTier;
    caller?: string;
    session_id?: string;
  };
}
/** Implementation lifecycle stage. */
export type ImplementationStatus = 'implemented' | 'planned' | 'conceptual';
/** Metadata describing a single skill (typically parsed from SKILL.md). */
export interface SkillMetadata {
  name: string;
  description: string;
  status: ImplementationStatus;
  version?: string;
  author?: string;
  tags?: string[];
  knowledge_tier?: TierLevel;
}
/** Top-level definition used in the generated skill-index.json. */
export interface SkillDefinition {
  name: string;
  description: string;
  status: ImplementationStatus;
}
/** Aggregate skill index file shape. */
export interface SkillIndex {
  total_skills: number;
  last_updated: string;
  skills: SkillDefinition[];
}
/** Minimal representation of a JSON Schema property descriptor. */
export interface SchemaProperty {
  type?: string;
  enum?: string[];
  description?: string;
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}
/** Minimal representation of a JSON Schema loaded from disk. */
export interface JsonSchema {
  $schema?: string;
  title?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaProperty>;
  additionalProperties?: boolean;
}
//# sourceMappingURL=types.d.ts.map
