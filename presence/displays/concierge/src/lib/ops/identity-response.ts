import { isRecord } from '@agent/core/foundation/primitives';

export type ClientIdentityPerson = {
  name: string | null;
  language: string | null;
  interaction_style: string | null;
  primary_domain: string | null;
  status: string | null;
};

export type ClientIdentityAgent = {
  agent_id: string | null;
  role: string | null;
  owner: string | null;
  trust_tier: string | null;
};

export type ClientIdentityResponse = {
  status: 'ok';
  onboarded: boolean;
  sovereign: ClientIdentityPerson | null;
  agent: ClientIdentityAgent | null;
  vision: string | null;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parsePerson(value: unknown): ClientIdentityPerson | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !nullableString(value.name) ||
    !nullableString(value.language) ||
    !nullableString(value.interaction_style) ||
    !nullableString(value.primary_domain) ||
    !nullableString(value.status)
  ) {
    return undefined;
  }
  return {
    name: value.name,
    language: value.language,
    interaction_style: value.interaction_style,
    primary_domain: value.primary_domain,
    status: value.status,
  };
}

function parseAgent(value: unknown): ClientIdentityAgent | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !nullableString(value.agent_id) ||
    !nullableString(value.role) ||
    !nullableString(value.owner) ||
    !nullableString(value.trust_tier)
  ) {
    return undefined;
  }
  return {
    agent_id: value.agent_id,
    role: value.role,
    owner: value.owner,
    trust_tier: value.trust_tier,
  };
}

export function parseIdentityResponse(value: unknown): ClientIdentityResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.status !== 'ok' ||
    typeof value.onboarded !== 'boolean' ||
    !nullableString(value.vision)
  ) {
    return undefined;
  }
  const sovereign = parsePerson(value.sovereign);
  const agent = parseAgent(value.agent);
  if (sovereign === undefined || agent === undefined) return undefined;
  return {
    status: 'ok',
    onboarded: value.onboarded,
    sovereign,
    agent,
    vision: value.vision,
  };
}
