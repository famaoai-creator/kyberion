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
import { pathResolver, rootResolve } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { nowIso } from './foundation/time.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';

const RELATIONSHIPS_ROOT = 'knowledge/confidential/relationships';
const RELATIONSHIP_NODE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/relationship-node.schema.json'
);
const HISTORY_MAX = 20;
const ALLOWED_SOURCES = ['presence-actuator', 'voice-actuator', 'manual'] as const;
export type RelationshipSource = (typeof ALLOWED_SOURCES)[number];

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
  return assertSafeRepositoryPath(
    rootResolve(path.join(RELATIONSHIPS_ROOT, safeOrg, `${safeSlug}.json`)),
    { allowMissingLeaf: true }
  );
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
      `[relationship-graph] unsupported source "${source}"; allowed: ${ALLOWED_SOURCES.join(', ')}`
    );
  }
}

const NODE_FIELDS = [
  'identity',
  'trust_level',
  'communication_style',
  'known_interests',
  'history',
  'long_term_summary',
  'outstanding_asks',
  'ng_topics',
  'pending_suggestions',
  'updated_at',
] as const;

function relationshipNodeCatalog(filePath: string) {
  return defineCatalog<RelationshipNode>({
    id: 'relationship-node',
    path: filePath,
    schema: RELATIONSHIP_NODE_SCHEMA_PATH,
  });
}

function recordFields(record: Record<string, unknown>, fields: readonly string[], label: string) {
  const allowed = new Set(fields);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains unknown fields`);
  }
}

function requiredString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  label: string
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  return requiredString(record, field, label);
}

function timestamp(record: Record<string, unknown>, field: string, label: string): string {
  const value = requiredString(record, field, label);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}.${field} must be a valid timestamp`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...value];
}

function optionalObject(
  record: Record<string, unknown>,
  field: string,
  label: string
): Record<string, unknown> | undefined {
  if (record[field] === undefined) return undefined;
  return parseSafeJsonObjectValue(record[field], `${label}.${field}`);
}

function parseRelationshipNode(value: unknown, org: string, personSlug: string): RelationshipNode {
  const root = parseSafeJsonObjectValue(value, '[relationship-graph] node');
  recordFields(root, NODE_FIELDS, '[relationship-graph] node');

  const identity = parseSafeJsonObjectValue(root.identity, '[relationship-graph] identity');
  recordFields(
    identity,
    ['name', 'role', 'org', 'person_slug', 'contact'],
    '[relationship-graph] identity'
  );
  const identityOrg = requiredString(identity, 'org', '[relationship-graph] identity');
  if (identityOrg !== org) throw new Error('[relationship-graph] identity org does not match path');
  const identityPersonSlug = optionalString(
    identity,
    'person_slug',
    '[relationship-graph] identity'
  );
  if (identityPersonSlug !== undefined && identityPersonSlug !== personSlug) {
    throw new Error('[relationship-graph] identity person_slug does not match path');
  }
  const contact = optionalObject(identity, 'contact', '[relationship-graph] identity');
  if (contact) {
    recordFields(contact, ['email', 'phone', 'preferred_channel'], '[relationship-graph] contact');
    optionalString(contact, 'email', '[relationship-graph] contact');
    optionalString(contact, 'phone', '[relationship-graph] contact');
    const preferredChannel = optionalString(
      contact,
      'preferred_channel',
      '[relationship-graph] contact'
    );
    if (
      preferredChannel !== undefined &&
      !['email', 'phone', 'slack', 'in_person', 'other'].includes(preferredChannel)
    ) {
      throw new Error('[relationship-graph] contact.preferred_channel is invalid');
    }
  }

  const trust = parseSafeJsonObjectValue(root.trust_level, '[relationship-graph] trust_level');
  recordFields(trust, ['current', 'updated_at', 'history'], '[relationship-graph] trust_level');
  if (
    typeof trust.current !== 'number' ||
    !Number.isInteger(trust.current) ||
    trust.current < 1 ||
    trust.current > 5
  ) {
    throw new Error('[relationship-graph] trust_level.current must be an integer from 1 to 5');
  }
  const trustHistory = trust.history;
  let parsedTrustHistory: Array<{ value: number; at: string; note?: string }> | undefined;
  if (trustHistory !== undefined) {
    if (!Array.isArray(trustHistory))
      throw new Error('[relationship-graph] trust_level.history must be an array');
    parsedTrustHistory = trustHistory.map((entry, index) => {
      const item = parseSafeJsonObjectValue(
        entry,
        `[relationship-graph] trust_level.history[${index}]`
      );
      recordFields(
        item,
        ['value', 'at', 'note'],
        `[relationship-graph] trust_level.history[${index}]`
      );
      if (
        typeof item.value !== 'number' ||
        !Number.isInteger(item.value) ||
        item.value < 1 ||
        item.value > 5
      ) {
        throw new Error(`[relationship-graph] trust_level.history[${index}].value is invalid`);
      }
      return {
        value: item.value,
        at: timestamp(item, 'at', `[relationship-graph] trust_level.history[${index}]`),
        ...(optionalString(item, 'note', `[relationship-graph] trust_level.history[${index}]`)
          ? {
              note: optionalString(
                item,
                'note',
                `[relationship-graph] trust_level.history[${index}]`
              ),
            }
          : {}),
      };
    });
  }

  const communicationStyle = optionalObject(
    root,
    'communication_style',
    '[relationship-graph] node'
  );
  if (communicationStyle) {
    recordFields(
      communicationStyle,
      ['honne_tatemae_tendency', 'preferred_medium', 'disliked_topics', 'tempo'],
      '[relationship-graph] communication_style'
    );
    const tendency = optionalString(
      communicationStyle,
      'honne_tatemae_tendency',
      '[relationship-graph] communication_style'
    );
    if (tendency !== undefined && !['direct', 'mixed', 'highly_implicit'].includes(tendency)) {
      throw new Error('[relationship-graph] communication_style.honne_tatemae_tendency is invalid');
    }
    optionalString(
      communicationStyle,
      'preferred_medium',
      '[relationship-graph] communication_style'
    );
    if (communicationStyle.disliked_topics !== undefined) {
      stringArray(
        communicationStyle.disliked_topics,
        '[relationship-graph] communication_style.disliked_topics'
      );
    }
    const tempo = optionalString(
      communicationStyle,
      'tempo',
      '[relationship-graph] communication_style'
    );
    if (tempo !== undefined && !['slow', 'balanced', 'fast'].includes(tempo)) {
      throw new Error('[relationship-graph] communication_style.tempo is invalid');
    }
  }

  const knownInterests = optionalObject(root, 'known_interests', '[relationship-graph] node');
  if (knownInterests) {
    recordFields(
      knownInterests,
      ['public', 'estimated_private'],
      '[relationship-graph] known_interests'
    );
    if (knownInterests.public !== undefined)
      stringArray(knownInterests.public, '[relationship-graph] known_interests.public');
    if (knownInterests.estimated_private !== undefined) {
      stringArray(
        knownInterests.estimated_private,
        '[relationship-graph] known_interests.estimated_private'
      );
    }
  }

  if (!Array.isArray(root.history) || root.history.length > HISTORY_MAX) {
    throw new Error(`[relationship-graph] history must contain at most ${HISTORY_MAX} entries`);
  }
  const history = root.history.map((entry, index) => {
    const item = parseSafeJsonObjectValue(entry, `[relationship-graph] history[${index}]`);
    recordFields(
      item,
      ['at', 'summary', 'channel', 'tone_shifts'],
      `[relationship-graph] history[${index}]`
    );
    return {
      at: timestamp(item, 'at', `[relationship-graph] history[${index}]`),
      summary: requiredString(item, 'summary', `[relationship-graph] history[${index}]`),
      ...(optionalString(item, 'channel', `[relationship-graph] history[${index}]`)
        ? { channel: optionalString(item, 'channel', `[relationship-graph] history[${index}]`) }
        : {}),
      ...(item.tone_shifts === undefined
        ? {}
        : {
            tone_shifts: stringArray(
              item.tone_shifts,
              `[relationship-graph] history[${index}].tone_shifts`
            ),
          }),
    };
  });

  const outstandingAsks = root.outstanding_asks;
  let parsedOutstandingAsks:
    Array<{ raised_at: string; content: string; status?: string }> | undefined;
  if (outstandingAsks !== undefined) {
    if (!Array.isArray(outstandingAsks))
      throw new Error('[relationship-graph] outstanding_asks must be an array');
    parsedOutstandingAsks = outstandingAsks.map((entry, index) => {
      const item = parseSafeJsonObjectValue(
        entry,
        `[relationship-graph] outstanding_asks[${index}]`
      );
      recordFields(
        item,
        ['raised_at', 'content', 'status'],
        `[relationship-graph] outstanding_asks[${index}]`
      );
      const status = optionalString(
        item,
        'status',
        `[relationship-graph] outstanding_asks[${index}]`
      );
      if (status !== undefined && !['open', 'addressed', 'declined'].includes(status)) {
        throw new Error(`[relationship-graph] outstanding_asks[${index}].status is invalid`);
      }
      return {
        raised_at: timestamp(item, 'raised_at', `[relationship-graph] outstanding_asks[${index}]`),
        content: requiredString(item, 'content', `[relationship-graph] outstanding_asks[${index}]`),
        ...(status ? { status } : {}),
      };
    });
  }

  const pendingSuggestions = root.pending_suggestions;
  let parsedPendingSuggestions: PendingSuggestion[] | undefined;
  if (pendingSuggestions !== undefined) {
    if (!Array.isArray(pendingSuggestions))
      throw new Error('[relationship-graph] pending_suggestions must be an array');
    parsedPendingSuggestions = pendingSuggestions.map((entry, index) => {
      const item = parseSafeJsonObjectValue(
        entry,
        `[relationship-graph] pending_suggestions[${index}]`
      );
      recordFields(
        item,
        ['source', 'field_path', 'proposed_value', 'detected_at'],
        `[relationship-graph] pending_suggestions[${index}]`
      );
      const source = requiredString(
        item,
        'source',
        `[relationship-graph] pending_suggestions[${index}]`
      );
      assertSource(source);
      return {
        source,
        field_path: requiredString(
          item,
          'field_path',
          `[relationship-graph] pending_suggestions[${index}]`
        ),
        proposed_value: item.proposed_value,
        detected_at: timestamp(
          item,
          'detected_at',
          `[relationship-graph] pending_suggestions[${index}]`
        ),
      };
    });
  }

  return {
    identity: {
      name: requiredString(identity, 'name', '[relationship-graph] identity'),
      ...(optionalString(identity, 'role', '[relationship-graph] identity')
        ? { role: optionalString(identity, 'role', '[relationship-graph] identity') }
        : {}),
      org: identityOrg,
      ...(identityPersonSlug ? { person_slug: identityPersonSlug } : {}),
      ...(contact ? { contact } : {}),
    },
    trust_level: {
      current: trust.current,
      updated_at: timestamp(trust, 'updated_at', '[relationship-graph] trust_level'),
      ...(parsedTrustHistory ? { history: parsedTrustHistory } : {}),
    },
    ...(communicationStyle ? { communication_style: communicationStyle } : {}),
    ...(knownInterests ? { known_interests: knownInterests } : {}),
    history,
    ...(optionalString(root, 'long_term_summary', '[relationship-graph] node')
      ? {
          long_term_summary: optionalString(root, 'long_term_summary', '[relationship-graph] node'),
        }
      : {}),
    ...(parsedOutstandingAsks ? { outstanding_asks: parsedOutstandingAsks } : {}),
    ...(root.ng_topics === undefined
      ? {}
      : { ng_topics: stringArray(root.ng_topics, '[relationship-graph] ng_topics') }),
    ...(parsedPendingSuggestions ? { pending_suggestions: parsedPendingSuggestions } : {}),
    updated_at: timestamp(root, 'updated_at', '[relationship-graph] node'),
  };
}

export function readNode(org: string, personSlug: string): RelationshipNode | null {
  const file = nodePath(org, personSlug);
  if (!safeExistsSync(file)) return null;
  const safeFile = assertSafeRepositoryPath(file, { allowMissingLeaf: false });
  if (!safeLstat(safeFile).isFile()) {
    throw new Error('[relationship-graph] relationship node must be a regular file');
  }
  return parseRelationshipNode(relationshipNodeCatalog(safeFile).load(), org, personSlug);
}

function writeNode(org: string, personSlug: string, node: RelationshipNode): void {
  const file = nodePath(org, personSlug);
  const schemaValidated = relationshipNodeCatalog(file).validate(node, file);
  const validated = parseRelationshipNode(schemaValidated, org, personSlug);
  safeWriteFile(file, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: 'utf8',
    mkdir: true,
  });
}

function initialNode(identity: RelationshipIdentity): RelationshipNode {
  const now = nowIso();
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
  node.updated_at = nowIso();
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
      `[relationship-graph] cannot suggest update — node missing for ${params.org}/${params.personSlug}`
    );
  }
  const suggestion: PendingSuggestion = {
    source: params.source,
    field_path: params.fieldPath,
    proposed_value: params.proposedValue,
    detected_at: nowIso(),
  };
  existing.pending_suggestions = [...(existing.pending_suggestions ?? []), suggestion];
  existing.updated_at = nowIso();
  writeNode(params.org, params.personSlug, existing);
  return existing;
}

export function listNgTopics(org: string, personSlug: string): string[] {
  return readNode(org, personSlug)?.ng_topics ?? [];
}

export function getTrustLevel(org: string, personSlug: string): number | null {
  return readNode(org, personSlug)?.trust_level.current ?? null;
}
