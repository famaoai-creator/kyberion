/**
 * Shared type definitions for Kyberion ecosystem.
 *
 * All TypeScript library modules import types from this file.
 * Import path: './types.js' (TypeScript resolves .js -> .ts under Node16 module resolution)
 */

// ---------------------------------------------------------------------------
// Knowledge Tiers
// ---------------------------------------------------------------------------

/** Knowledge-tier hierarchy levels. */
export type TierLevel = 'personal' | 'confidential' | 'public';

/** Alias kept for backward compatibility with earlier type exports. */
export type KnowledgeTier = TierLevel;

/** Numeric weight map for tier comparison (higher = more sensitive). */
export type TierWeightMap = Record<TierLevel, number>;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tier Guard
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// IO & Security
// ---------------------------------------------------------------------------

/** Options for safe file reading. */
export interface SafeReadOptions {
  /** Maximum file size in MB (default: 100). */
  maxSizeMB?: number;
  /** File encoding (default: 'utf8'). */
  encoding?: BufferEncoding;
  /** Label for error messages. */
  label?: string;
  /** Whether to use memory cache (default: true). */
  cache?: boolean;
}

/** Options for safe file writing. */
export interface SafeWriteOptions {
  /** Create parent directory if missing (default: true). */
  mkdir?: boolean;
  /** File encoding (default: 'utf8'). */
  encoding?: BufferEncoding;
}

/** Result of write permission validation. */
export interface WriteGuardResult {
  allowed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/** Internal cache entry structure. */
export interface CacheEntry<T = any> {
  value: T;
  timestamp: number;
  ttl: number;
  persistent: boolean;
}

/** Options for initializing a Cache instance. */
export interface CacheOptions {
  /** Maximum number of entries in memory (default: 100). */
  maxSize?: number;
  /** Default time-to-live in ms (default: 1 hour). */
  ttlMs?: number;
  /** Directory for disk persistence. */
  persistenceDir?: string;
}

// ---------------------------------------------------------------------------
// Skill I/O Envelope
// ---------------------------------------------------------------------------

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
    role?: string;
    execution_tier?: TierLevel;
    system_directive?: string;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
    suggestion?: string;
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

// ---------------------------------------------------------------------------
// Skill Metadata & Index
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// JSON Schema (lightweight internal representation)
// ---------------------------------------------------------------------------

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
