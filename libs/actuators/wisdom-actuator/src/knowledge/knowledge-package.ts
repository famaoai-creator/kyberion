import * as AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import type { Ajv as AjvInstance, Options, ValidateFunction } from 'ajv';
import { compileSchemaFromPath, pathResolver, signA2AContent, verifyA2AContent } from '@agent/core';

export type KnowledgeTier = 'personal' | 'confidential' | 'public';
export type KnowledgePackageSignatureStatus = 'absent' | 'verified' | 'rejected';

export interface KnowledgePackageSignature {
  status: KnowledgePackageSignatureStatus;
  algorithm?: 'hmac-sha256';
  key_id?: string;
  value?: string;
}

export interface KnowledgePackage {
  metadata: {
    package_version: string;
    package_id: string;
    origin_agent_id: string;
    origin_tenant_id: string;
    origin_project_id?: string;
    source_tier: KnowledgeTier;
    requested_target_tier: KnowledgeTier;
    content_hash: string;
    created_at: string;
    provenance: string[];
    trust_status: 'unverified' | 'verified' | 'rejected';
    signature: KnowledgePackageSignature;
    payload_encoding: 'utf8';
  };
  content: {
    path: string;
    raw_data: string;
  };
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SCHEMA_PATH = pathResolver.rootResolve('schemas/knowledge-package.schema.json');
type AjvConstructor = new (options?: Options) => AjvInstance;
type AddFormats = (instance: AjvInstance) => AjvInstance;
const AjvConstructor =
  (AjvModule as unknown as { default?: AjvConstructor }).default ||
  (AjvModule as unknown as AjvConstructor);
const addFormats =
  (addFormatsModule as unknown as { default?: AddFormats }).default ||
  (addFormatsModule as unknown as AddFormats);
const ajv = new AjvConstructor({ allErrors: true });
addFormats(ajv);
const validateSchema: ValidateFunction = compileSchemaFromPath(ajv, SCHEMA_PATH);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)])
  );
}

function signingPayload(pkg: KnowledgePackage): string {
  return JSON.stringify(
    stableValue({
      metadata: { ...pkg.metadata, signature: undefined },
      content: pkg.content,
    })
  );
}

export function normalizeKnowledgeTier(value: unknown): KnowledgeTier {
  const tier = String(value || 'confidential')
    .trim()
    .toLowerCase();
  if (tier !== 'personal' && tier !== 'confidential' && tier !== 'public') {
    throw new Error(`Invalid knowledge import tier: ${value}`);
  }
  return tier;
}

export function normalizeKnowledgePackageAgentId(value: unknown): string {
  const agentId = String(value || '').trim();
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`Invalid knowledge package origin_agent_id: ${value}`);
  }
  return agentId;
}

export function assertKnowledgePackage(value: unknown): KnowledgePackage {
  if (!validateSchema(value)) {
    const detail = (validateSchema.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`[KNOWLEDGE_PACKAGE_SCHEMA_INVALID] ${detail}`);
  }
  const pkg = value as KnowledgePackage;
  normalizeKnowledgePackageAgentId(pkg.metadata.origin_agent_id);
  if (!pkg.metadata.origin_tenant_id.trim()) {
    throw new Error('[KNOWLEDGE_ORIGIN_SCOPE_REQUIRED] origin_tenant_id is required');
  }
  if (!HASH_PATTERN.test(pkg.metadata.content_hash)) {
    throw new Error('[KNOWLEDGE_PACKAGE_INVALID] content_hash must be sha256');
  }
  return pkg;
}

export function createKnowledgePackage(input: {
  packageVersion?: string;
  packageId: string;
  originAgentId: string;
  originTenantId: string;
  originProjectId?: string;
  sourceTier: KnowledgeTier;
  requestedTargetTier: KnowledgeTier;
  contentHash: string;
  createdAt: string;
  provenance: string[];
  contentPath: string;
  rawData: string;
}): KnowledgePackage {
  const unsigned: KnowledgePackage = {
    metadata: {
      package_version: input.packageVersion || '1.0.0',
      package_id: input.packageId,
      origin_agent_id: normalizeKnowledgePackageAgentId(input.originAgentId),
      origin_tenant_id: input.originTenantId,
      ...(input.originProjectId ? { origin_project_id: input.originProjectId } : {}),
      source_tier: input.sourceTier,
      requested_target_tier: input.requestedTargetTier,
      content_hash: input.contentHash,
      created_at: input.createdAt,
      provenance: input.provenance,
      trust_status: 'verified',
      signature: { status: 'absent' },
      payload_encoding: 'utf8',
    },
    content: { path: input.contentPath, raw_data: input.rawData },
  };
  const signed = signA2AContent(signingPayload(unsigned));
  const pkg: KnowledgePackage = {
    ...unsigned,
    metadata: {
      ...unsigned.metadata,
      signature: {
        status: 'verified',
        algorithm: signed.sig_alg,
        key_id: 'kyberion-a2a-secret',
        value: signed.signature,
      },
    },
  };
  return assertKnowledgePackage(pkg);
}

export function assertKnowledgePackageTrusted(pkg: KnowledgePackage): void {
  if (pkg.metadata.trust_status !== 'verified' || pkg.metadata.signature.status !== 'verified') {
    throw new Error('[KNOWLEDGE_PACKAGE_UNTRUSTED] verified signature is required');
  }
  if (
    pkg.metadata.signature.algorithm !== 'hmac-sha256' ||
    !pkg.metadata.signature.key_id ||
    !pkg.metadata.signature.value
  ) {
    throw new Error('[KNOWLEDGE_PACKAGE_SIGNATURE_INVALID] signature metadata is incomplete');
  }
  const verification = verifyA2AContent(signingPayload(pkg), pkg.metadata.signature.value);
  if (!verification.valid) {
    throw new Error(
      `[KNOWLEDGE_PACKAGE_SIGNATURE_INVALID] ${verification.reason || 'invalid signature'}`
    );
  }
}
