/**
 * libs/core/procedure-types.ts
 * Substrate-neutral contract types for intent-driven automation (learn → replay).
 *
 * FROZEN CONTRACT (Phase 0). These types are shared across ALL substrate adapters
 * (browser / desktop / service / media). Only the recorder + compiler differ per
 * substrate; intent-resolution (Layer ①), self-repair (Layer ④) and promotion
 * (distill-candidate-registry) consume these shapes unchanged.
 *
 * Design: docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md §6 (master contract)
 *         docs/INTENT_DRIVEN_{SERVICE,DESKTOP,MEDIA}_AUTOMATION_DESIGN.ja.md (adapters)
 *
 * Changing any signature here is a contract change — follow the master §9 protocol
 * (owner updates the contract, all adapter agents follow) rather than editing locally.
 */

/** Implemented + planned substrates. Adding one is a deliberate contract change. */
export type ProcedureSubstrate = 'browser' | 'desktop' | 'service' | 'media';

/** Risk band used as a feature for approval gating (actual gate lives in approval-policy). */
export type ProcedureRiskClass = 'low' | 'medium' | 'high';

/** Pattern A = learn-by-demonstration, Pattern B = resolve-and-execute. */
export type ProcedurePattern = 'A' | 'B';

/**
 * Intent-resolution confidence thresholds (master §6.2, frozen 2026-06-23).
 * Overridable via config; these are the agreed initial values.
 */
export const PROCEDURE_RESOLUTION_THRESHOLDS = {
  /** >= this → Pattern B (auto-execute). */
  autoExecute: 0.75,
  /** < this → Pattern A (learn). Between the two → confirm with the user. */
  learn: 0.4,
} as const;

/** A variable input the procedure expects at run time ({{input.*}} candidate). */
export interface ProcedureInput {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'table' | 'date';
  optional?: boolean;
}

/** A secret the procedure needs, resolved via secret-guard at run time (never stored inline). */
export interface ProcedureSecret {
  /** Service / credential identifier (e.g. "jira", "kingoftime_login"). */
  name: string;
  /** Data tier scope, e.g. "confidential/{project}" or "personal". */
  scope: string;
}

/**
 * Per-substrate identifier of what the procedure acts on. Interpretation is
 * substrate-dependent (origins for browser, services for service, app/platform for
 * desktop) but the resolver only needs `name` for matching.
 */
export interface ProcedureTarget {
  name: string;
  /** browser: allowed origins. */
  origins?: string[];
  /** service: service_ids involved. */
  services?: string[];
  /** desktop: target platform. */
  platform?: string;
}

/** How a procedure is recorded and executed (the substrate adapter binding). */
export interface ProcedureAdapter {
  /** e.g. "chrome-extension" | "service-capture" | "desktop-capture" | "media-distill". */
  recorder: string;
  /** e.g. "extension_session" | "service:preset" | "system" | "media:pipeline". */
  executor: string;
  /**
   * browser: repo-relative path to the reviewed BrowserExtensionRecording that
   * backs this procedure. The dispatcher loads it to issue an execution lease.
   * MUST resolve inside the allowlisted recordings store (see procedure-registry).
   */
  recording_ref?: string;
  /** media: reference to the distilled generation recipe. */
  recipe_ref?: string;
}

/**
 * One registry entry. Persisted in knowledge/product/orchestration/procedures.json.
 * `substrate`/`adapter`/`target` are the discriminator; every other field is common
 * to all substrates and is all the resolver (Layer ①) needs.
 */
export interface ProcedureEntry {
  procedure_id: string;
  substrate: ProcedureSubstrate;
  adapter: ProcedureAdapter;
  target: ProcedureTarget;
  /** Natural-language phrases used as features for intent resolution. */
  intent_phrases: string[];
  /** browser-only: execution substrate selection (master §4). */
  execution_substrate?: 'extension' | 'playwright';
  /** Path to the promoted, runnable pipeline. */
  pipeline_ref: string;
  required_inputs?: ProcedureInput[];
  required_secrets?: ProcedureSecret[];
  risk_class: ProcedureRiskClass;
  golden_scenario_ref?: string;
  /** Semver. */
  version: string;
  status: 'active' | 'deprecated';
}

/** Top-level shape of the procedures.json catalog. */
export interface ProcedureCatalog {
  schema_version: 'procedures.v1';
  procedures: ProcedureEntry[];
}

/** A single ranked candidate produced during intent resolution. */
export interface ProcedureCandidate {
  procedure_id: string;
  /** 0..1 */
  confidence: number;
  reason: string;
}

/**
 * Result of resolveProcedure(). Runtime-only (not persisted), so no JSON schema.
 * Master §6.2.
 */
export interface ProcedureResolution {
  outcome: 'matched' | 'ambiguous' | 'unmatched';
  best?: { procedure_id: string; confidence: number };
  candidates: ProcedureCandidate[];
  recommendedPattern: ProcedurePattern;
}

/**
 * A correction learned via self-repair (Layer ④). The recording is spliced into the
 * promoted pipeline after `anchor.step_index`. Promotion remains human-reviewed.
 * Persisted; validated by procedure-delta.schema.json.
 */
export interface ProcedureDelta {
  schema_version: 'procedure-delta.v1';
  procedure_id: string;
  anchor: {
    step_index: number;
    /** Snapshot/target hash of the anchor step, where applicable. */
    ref_snapshot_hash?: string;
  };
  /** Reference to the substrate recording capturing the corrective steps. */
  delta_recording_ref: string;
  reason: 'ambiguity' | 'handoff' | 'new_popup' | 'mfa';
  created_at: string;
}

/** One verifiable success condition checked after execution. */
export interface GoldenSuccessCondition {
  /** Substrate-neutral assertion kinds; adapters use the subset they support. */
  kind:
    | 'ref_visible'
    | 'text_present'
    | 'response_field'
    | 'screenshot_state'
    | 'file_generated'
    | 'theme_applied'
    | 'structure_match';
  role?: string;
  name_contains?: string;
  /** Free-form assertion params, kept open for substrate-specific detail. */
  params?: Record<string, unknown>;
}

/**
 * Success criteria captured at distillation and checked after each run.
 * Persisted; validated by golden-scenario.schema.json. Master §6.4.
 */
export interface GoldenScenario {
  schema_version: 'golden-scenario.v1';
  scenario_id: string;
  procedure_id: string;
  success_conditions: GoldenSuccessCondition[];
  /** receipt_id (or equivalent) this scenario was captured from. */
  captured_from: string;
  version: string;
}
