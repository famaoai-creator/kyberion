/**
 * External-harness registry (PoC).
 *
 * Describing-only catalog of out-of-process agent harnesses (ACP servers,
 * provider CLIs, managed processes), modeled on OpenHands'
 * `acp_router.py` discovery surface and Preloop's `agents/factory.py`
 * `_AGENT_EXECUTOR_REGISTRY`: one descriptor per harness, capability-driven
 * resolution, no live dispatch and no spawning. A dispatcher that later
 * consumes this registry resolves a descriptor here, then hands it to the
 * existing adapter/dispatch seams (`agent-adapter.ts`, `agent-dispatch.ts`).
 */

import { isRecord } from '../foundation/primitives.js';
import { KNOWLEDGE_TIERS, type KnowledgeTier } from '../foundation/knowledge-tier.js';
import type { MissionValidationMessage } from '../mission/mission-blueprint-validation.js';

export type HarnessKind = 'acp' | 'cli' | 'process';
export type HarnessTrustTier = KnowledgeTier;
export type HarnessStatus = 'available' | 'unavailable' | 'retired';

export interface HarnessDescriptor {
  harness_id: string;
  kind: HarnessKind;
  /** Optional reference into the adapter plane (e.g. an AgentAdapter/dispatcher name). */
  adapter_ref?: string;
  /** ACP endpoint URL or CLI/process command line, per {@link HarnessDescriptor.kind}. */
  endpoint_or_command?: string;
  capabilities: string[];
  trust_tier: HarnessTrustTier;
  status: HarnessStatus;
  provider?: string;
}

export type HarnessValidationMessage = MissionValidationMessage;

export const HARNESS_KINDS: readonly HarnessKind[] = ['acp', 'cli', 'process'];
export const HARNESS_STATUSES: readonly HarnessStatus[] = ['available', 'unavailable', 'retired'];

function error(code: string, message: string, subjectId?: string): HarnessValidationMessage {
  return { severity: 'error', code, message, ...(subjectId ? { subject_id: subjectId } : {}) };
}

function warning(code: string, message: string, subjectId?: string): HarnessValidationMessage {
  return { severity: 'warning', code, message, ...(subjectId ? { subject_id: subjectId } : {}) };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean)
    : [];
}

/** Collect-all descriptor validation; never throws on malformed input. */
export function validateHarnessDescriptor(input: unknown): HarnessValidationMessage[] {
  const messages: HarnessValidationMessage[] = [];
  if (!isRecord(input)) {
    messages.push(error('HARNESS_DESCRIPTOR_NOT_OBJECT', 'harness descriptor must be an object'));
    return messages;
  }

  const harnessId = String(input.harness_id ?? '').trim();
  if (!harnessId) {
    messages.push(error('HARNESS_ID_REQUIRED', 'harness descriptor is missing harness_id'));
  }

  const kind = String(input.kind ?? '').trim();
  if (!HARNESS_KINDS.includes(kind as HarnessKind)) {
    messages.push(
      error(
        'HARNESS_KIND_INVALID',
        `harness ${harnessId || '(unknown)'} has unknown kind '${kind || '(missing)'}'`,
        harnessId || undefined
      )
    );
  }

  const trustTier = String(input.trust_tier ?? '').trim();
  if (!KNOWLEDGE_TIERS.includes(trustTier as KnowledgeTier)) {
    messages.push(
      error(
        'HARNESS_TRUST_TIER_INVALID',
        `harness ${harnessId || '(unknown)'} has unknown trust_tier '${trustTier || '(missing)'}'`,
        harnessId || undefined
      )
    );
  }

  const status = String(input.status ?? '').trim();
  if (!HARNESS_STATUSES.includes(status as HarnessStatus)) {
    messages.push(
      error(
        'HARNESS_STATUS_INVALID',
        `harness ${harnessId || '(unknown)'} has unknown status '${status || '(missing)'}'`,
        harnessId || undefined
      )
    );
  }

  if (input.capabilities === undefined) {
    messages.push(
      error(
        'HARNESS_CAPABILITIES_REQUIRED',
        `harness ${harnessId || '(unknown)'} must declare capabilities`,
        harnessId || undefined
      )
    );
  } else if (!Array.isArray(input.capabilities)) {
    messages.push(
      error(
        'HARNESS_CAPABILITIES_INVALID',
        `harness ${harnessId || '(unknown)'} capabilities must be an array`,
        harnessId || undefined
      )
    );
  } else if (stringList(input.capabilities).length === 0) {
    messages.push(
      error(
        'HARNESS_CAPABILITIES_REQUIRED',
        `harness ${harnessId || '(unknown)'} must declare at least one capability`,
        harnessId || undefined
      )
    );
  } else if (input.capabilities.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    messages.push(
      warning(
        'HARNESS_CAPABILITY_ENTRY_INVALID',
        `harness ${harnessId || '(unknown)'} has non-string or empty capability entries`,
        harnessId || undefined
      )
    );
  }

  const endpoint = String(input.endpoint_or_command ?? '').trim();
  if ((kind === 'acp' || kind === 'cli') && !endpoint) {
    messages.push(
      error(
        'HARNESS_ENDPOINT_REQUIRED',
        `harness ${harnessId || '(unknown)'} of kind '${kind}' requires endpoint_or_command`,
        harnessId || undefined
      )
    );
  }

  if (input.adapter_ref !== undefined && typeof input.adapter_ref !== 'string') {
    messages.push(
      error(
        'HARNESS_ADAPTER_REF_INVALID',
        `harness ${harnessId || '(unknown)'} adapter_ref must be a string`,
        harnessId || undefined
      )
    );
  }
  if (input.provider !== undefined && typeof input.provider !== 'string') {
    messages.push(
      error(
        'HARNESS_PROVIDER_INVALID',
        `harness ${harnessId || '(unknown)'} provider must be a string`,
        harnessId || undefined
      )
    );
  }

  if (status === 'retired') {
    messages.push(
      warning(
        'HARNESS_STATUS_RETIRED',
        `harness ${harnessId || '(unknown)'} is retired and will never resolve`,
        harnessId || undefined
      )
    );
  }

  return messages;
}

function hasErrors(messages: HarnessValidationMessage[]): boolean {
  return messages.some((message) => message.severity === 'error');
}

function normalizeDescriptor(input: Record<string, unknown>): HarnessDescriptor {
  const descriptor: HarnessDescriptor = {
    harness_id: String(input.harness_id).trim(),
    kind: String(input.kind).trim() as HarnessKind,
    capabilities: [...new Set(stringList(input.capabilities))],
    trust_tier: String(input.trust_tier).trim() as HarnessTrustTier,
    status: String(input.status).trim() as HarnessStatus,
  };
  const adapterRef = String(input.adapter_ref ?? '').trim();
  if (adapterRef) descriptor.adapter_ref = adapterRef;
  const endpoint = String(input.endpoint_or_command ?? '').trim();
  if (endpoint) descriptor.endpoint_or_command = endpoint;
  const provider = String(input.provider ?? '').trim();
  if (provider) descriptor.provider = provider;
  Object.freeze(descriptor.capabilities);
  return Object.freeze(descriptor);
}

export interface HarnessListFilter {
  status?: HarnessStatus;
  provider?: string;
}

export interface ExternalHarnessRegistry {
  /**
   * Validate then register. Returns collect-all messages; the descriptor is
   * stored only when no error-severity messages were produced.
   */
  registerHarness(input: unknown): HarnessValidationMessage[];
  listHarnesses(filter?: HarnessListFilter): HarnessDescriptor[];
  getHarness(harnessId: string): HarnessDescriptor | undefined;
  /** First 'available' harness declaring the capability (registration order). */
  resolveHarness(capability: string): HarnessDescriptor | undefined;
  updateHarnessStatus(harnessId: string, status: HarnessStatus): boolean;
}

/** In-memory only — a describing surface; persistence is out of scope for the PoC. */
export function createExternalHarnessRegistry(): ExternalHarnessRegistry {
  const harnesses = new Map<string, HarnessDescriptor>();

  const registerHarness = (input: unknown): HarnessValidationMessage[] => {
    const messages = validateHarnessDescriptor(input);
    if (isRecord(input)) {
      const harnessId = String(input.harness_id ?? '').trim();
      if (harnessId && harnesses.has(harnessId)) {
        messages.push(
          error('HARNESS_ID_DUPLICATE', `duplicate harness_id '${harnessId}'`, harnessId)
        );
      }
    }
    if (hasErrors(messages)) return messages;
    const descriptor = normalizeDescriptor(input as Record<string, unknown>);
    harnesses.set(descriptor.harness_id, descriptor);
    return messages;
  };

  return {
    registerHarness,
    listHarnesses(filter) {
      let results = [...harnesses.values()];
      if (filter?.status) results = results.filter((h) => h.status === filter.status);
      if (filter?.provider) results = results.filter((h) => h.provider === filter.provider);
      return results;
    },
    getHarness(harnessId) {
      return harnesses.get(harnessId);
    },
    resolveHarness(capability) {
      const needle = capability.trim();
      if (!needle) return undefined;
      return [...harnesses.values()].find(
        (h) => h.status === 'available' && h.capabilities.includes(needle)
      );
    },
    updateHarnessStatus(harnessId, status) {
      const existing = harnesses.get(harnessId);
      if (!existing) return false;
      harnesses.set(harnessId, Object.freeze({ ...existing, status }));
      return true;
    },
  };
}
