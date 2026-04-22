/**
 * Relationship Graph Store — read/update hooks that presence and voice
 * actuators call after stakeholder interactions so the confidential
 * relationship-graph stays curated automatically.
 *
 * Implements CONCEPT_INTEGRATION_BACKLOG P2-3 at the store level.
 * Direct merges into trust_level, history, and known_interests require
 * manual review and therefore land on pending_suggestions first rather
 * than mutating the authoritative fields. Only append-to-history from
 * trusted actuators is committed directly, since it is additive and
 * bounded (schema caps at 20 entries).
 */

import * as path from 'node:path';
import { rootResolve } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';

const RELATIONSHIPS_ROOT = 'knowledge/confidential/relationships';
const HISTORY_MAX = 20;
const ALLOWED_SOURCES = ['presence-actuator', 'voice-actuator', 'manual'] as const;
export type RelationshipSource = typeof ALLOWED_SOURCES[number];

export interface RelationshipIdentity {
  name: string;
  role?: string;
  org: string;
  person_slug?: string;
  contact?: Record<string, unknown>;
}

export interface InteractionEntry {
  at: string;
  summary: string;
  channel?: string;
  tone_shifts?: string[];
}

export interface PendingSuggestion {
  source: RelationshipSource;
  field_path: string;
  proposed_value: unknown;
  detected_at: string;
}

export interface RelationshipNode {
  identity: RelationshipIdentity;
  trust_level: {
    current: number;
    updated_at: string;
    history?: Array<{ value: number; at: string; note?: string }>;
  };
  communication_style?: Record<string, unknown>;
  known_interests?: Record<string, unknown>;
  history: InteractionEntry[];
  long_term_summary?: string;
  outstanding_asks?: Array<{ raised_at: string; content: string; status?: string }>;
  ng_topics?: string[];
  pending_suggestions?: PendingSuggestion[];
  updated_at: string;
}

export interface RecordInteractionParams {
  personSlug: string;
  org: string;
  interaction: InteractionEntry;
  source: RelationshipSource;
}

export interface SuggestFieldUpdateParams {
  personSlug: string;
  org: string;
  fieldPath: string;
  proposedValue: unknown;
  source: RelationshipSource;
}

function nodePath(org: string, personSlug: string): string {
  const safeOrg = sanitizeSegment(org);
  const safeSlug = sanitizeSegment(personSlug);
  return rootResolve(path.join(RELATIONSHIPS_ROOT, safeOrg, `${safeSlug}.json`));
}

function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('[relationship-graph] empty path segment');
  if (/[\/\\]/.test(trimmed) || trimmed.includes('..')) {
    throw new Error(`[relationship-graph] illegal path segment: ${value}`);
  }
  return trimmed;
}

function assertSource(source: string): asserts source is RelationshipSource {
  if (!ALLOWED_SOURCES.includes(source as RelationshipSource)) {
    throw new Error(
      `[relationship-graph] unsupported source "${source}"; allowed: ${ALLOWED_SOURCES.join(', ')}`,
    );
  }
}

export function readNode(org: string, personSlug: string): RelationshipNode | null {
  const file = nodePath(org, personSlug);
  if (!safeExistsSync(file)) return null;
  const raw = safeReadFile(file, { encoding: 'utf8' }) as string;
  return JSON.parse(raw) as RelationshipNode;
}

function writeNode(org: string, personSlug: string, node: RelationshipNode): void {
  const file = nodePath(org, personSlug);
  safeWriteFile(file, `${JSON.stringify(node, null, 2)}\n`, { encoding: 'utf8', mkdir: true });
}

function initialNode(identity: RelationshipIdentity): RelationshipNode {
  const now = new Date().toISOString();
  return {
    identity,
    trust_level: { current: 3, updated_at: now, history: [] },
    history: [],
    updated_at: now,
  };
}

/**
 * Append an interaction record to the rolling history. Trusted actuators
 * (presence / voice) may commit directly because history is additive
 * and bounded. If the node does not exist it is auto-created with
 * trust_level=3 (neutral) so the first interaction does not require a
 * manual bootstrap step.
 */
export function recordInteraction(params: RecordInteractionParams): RelationshipNode {
  assertSource(params.source);
  const existing = readNode(params.org, params.personSlug);
  const node =
    existing ??
    initialNode({
      name: params.personSlug,
      org: params.org,
      person_slug: params.personSlug,
    });

  node.history = [...node.history, params.interaction].slice(-HISTORY_MAX);
  node.updated_at = new Date().toISOString();
  writeNode(params.org, params.personSlug, node);
  return node;
}

/**
 * Queue a proposed field update onto pending_suggestions so it can be
 * reviewed before mutating authoritative fields (trust_level,
 * known_interests, communication_style). Never applies changes directly.
 */
export function suggestFieldUpdate(params: SuggestFieldUpdateParams): RelationshipNode {
  assertSource(params.source);
  const existing = readNode(params.org, params.personSlug);
  if (!existing) {
    throw new Error(
      `[relationship-graph] cannot suggest update — node missing for ${params.org}/${params.personSlug}`,
    );
  }
  const suggestion: PendingSuggestion = {
    source: params.source,
    field_path: params.fieldPath,
    proposed_value: params.proposedValue,
    detected_at: new Date().toISOString(),
  };
  existing.pending_suggestions = [...(existing.pending_suggestions ?? []), suggestion];
  existing.updated_at = new Date().toISOString();
  writeNode(params.org, params.personSlug, existing);
  return existing;
}

export function listNgTopics(org: string, personSlug: string): string[] {
  return readNode(org, personSlug)?.ng_topics ?? [];
}

export function getTrustLevel(org: string, personSlug: string): number | null {
  return readNode(org, personSlug)?.trust_level.current ?? null;
}
