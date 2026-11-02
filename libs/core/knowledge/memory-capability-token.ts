/**
 * Memory capability token (PoC).
 *
 * Run-scoped, self-contained capability grant for governed memory access,
 * modeled on tandem's `MemoryCapabilityToken`
 * (tandem/crates/tandem-memory/src/governance.rs): an issuer signs a bounded
 * set of ops over one partition, and a verifier can check it fully offline.
 *
 * Signing is HMAC-SHA-256 over a canonical (key-sorted) JSON payload. The
 * signing secret defaults to the audit-chain key resolution
 * (`resolveAuditChainKey` — env `KYBERION_AUDIT_CHAIN_KEY` or the registered
 * chain-integrity IO); an explicit `secret` option wins when provided so a
 * caller (or test) can pin verification to an injected key.
 *
 * Enforcement into existing write paths (`tier-guard.ts`) is deliberately NOT
 * wired here — this module is the helper plus tests only.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveAuditChainKey } from '../chain-integrity.js';
import { isRecord } from '../foundation/primitives.js';
import { nowIso, parseIso } from '../foundation/time.js';
import { KNOWLEDGE_TIERS, type KnowledgeTier } from '../foundation/knowledge-tier.js';

export const MEMORY_CAPABILITY_OPS = Object.freeze(['read', 'write', 'promote'] as const);
export type MemoryCapabilityOp = (typeof MEMORY_CAPABILITY_OPS)[number];

export type MemoryCapabilitySignatureAlg = 'hmac-sha256';

export interface MemoryCapabilityTokenPayload {
  version: 1;
  token_id: string;
  issuer: string;
  subject: string;
  /** Normalized partition key: the explicit partition, or `tier:<tier>`. */
  partition: string;
  ops: MemoryCapabilityOp[];
  issued_at: string;
  expires_at: string;
}

export interface MemoryCapabilityToken {
  payload: MemoryCapabilityTokenPayload;
  sig_alg: MemoryCapabilitySignatureAlg;
  signature: string;
}

export type MemoryCapabilityValidationFailure =
  | 'malformed_token'
  | 'signature_mismatch'
  | 'expired'
  | 'partition_mismatch'
  | 'op_not_granted'
  | 'secret_unavailable'
  | 'invalid_check';

export interface MemoryCapabilityValidationResult {
  ok: boolean;
  reason?: MemoryCapabilityValidationFailure;
}

export interface MemoryCapabilityTokenOptions {
  /** Injected HMAC secret; takes precedence over audit-chain key resolution. */
  secret?: string;
  /** Issuance-time override (Date, epoch ms, or ISO string); defaults to now. */
  now?: Date | number | string;
}

export interface IssueMemoryCapabilityTokenInput {
  /** Explicit partition key (e.g. 'confidential/acme-corp'); wins over `tier`. */
  partition?: string;
  /** Tier shorthand — normalized to `tier:<tier>` when no partition is given. */
  tier?: KnowledgeTier;
  ops: readonly MemoryCapabilityOp[];
  subject: string;
  issuer: string;
  expiresAt: Date | number | string;
}

export interface ValidateMemoryCapabilityTokenInput {
  partition?: string;
  tier?: KnowledgeTier;
  op: MemoryCapabilityOp;
  now?: Date | number | string;
}

function toIso(value: Date | number | string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return parseIso(value).toISOString();
}

function toEpochMs(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return parseIso(value).getTime();
}

function normalizePartition(input: { partition?: string; tier?: KnowledgeTier }): string | null {
  const explicit = typeof input.partition === 'string' ? input.partition.trim() : '';
  if (explicit) return explicit;
  if (input.tier && KNOWLEDGE_TIERS.includes(input.tier)) return `tier:${input.tier}`;
  return null;
}

/** Deterministic JSON: object keys sorted recursively so verification is order-independent. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function resolveTokenSecret(options?: MemoryCapabilityTokenOptions): string {
  const explicit = options?.secret?.trim();
  if (explicit) return explicit;
  try {
    const chainKey = resolveAuditChainKey();
    if (chainKey) return chainKey;
  } catch {
    // Chain IO is not registered in this process — fall through to the error.
  }
  throw new Error('missing_memory_capability_secret');
}

function signPayload(payload: MemoryCapabilityTokenPayload, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
}

function signaturesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Issue a signed, self-contained token. Throws on structurally invalid input. */
export function issueMemoryCapabilityToken(
  input: IssueMemoryCapabilityTokenInput,
  options?: MemoryCapabilityTokenOptions
): MemoryCapabilityToken {
  const partition = normalizePartition(input);
  if (!partition) throw new Error('memory_capability_partition_required');

  const issuer = String(input.issuer ?? '').trim();
  if (!issuer) throw new Error('memory_capability_issuer_required');
  const subject = String(input.subject ?? '').trim();
  if (!subject) throw new Error('memory_capability_subject_required');

  if (!Array.isArray(input.ops) || input.ops.length === 0) {
    throw new Error('memory_capability_ops_required');
  }
  const ops = [...new Set(input.ops)];
  for (const op of ops) {
    if (!MEMORY_CAPABILITY_OPS.includes(op)) {
      throw new Error(`unknown_memory_capability_op:${String(op)}`);
    }
  }

  const payload: MemoryCapabilityTokenPayload = {
    version: 1,
    token_id: randomUUID(),
    issuer,
    subject,
    partition,
    ops,
    issued_at: options?.now !== undefined ? toIso(options.now) : nowIso(),
    expires_at: toIso(input.expiresAt),
  };
  return {
    payload,
    sig_alg: 'hmac-sha256',
    signature: signPayload(payload, resolveTokenSecret(options)),
  };
}

function readPayload(token: unknown): MemoryCapabilityTokenPayload | null {
  if (!isRecord(token) || !isRecord(token.payload)) return null;
  const payload = token.payload;
  if (
    typeof payload.token_id !== 'string' ||
    typeof payload.issuer !== 'string' ||
    typeof payload.subject !== 'string' ||
    typeof payload.partition !== 'string' ||
    !Array.isArray(payload.ops) ||
    typeof payload.expires_at !== 'string'
  ) {
    return null;
  }
  return payload as unknown as MemoryCapabilityTokenPayload;
}

/** Verify a token offline: signature, expiry, partition binding, and op grant. */
export function validateMemoryCapabilityToken(
  token: unknown,
  check: ValidateMemoryCapabilityTokenInput,
  options?: Pick<MemoryCapabilityTokenOptions, 'secret'>
): MemoryCapabilityValidationResult {
  if (!isRecord(token) || token.sig_alg !== 'hmac-sha256' || typeof token.signature !== 'string') {
    return { ok: false, reason: 'malformed_token' };
  }
  const payload = readPayload(token);
  if (!payload) return { ok: false, reason: 'malformed_token' };

  let secret: string;
  try {
    secret = resolveTokenSecret(options);
  } catch {
    return { ok: false, reason: 'secret_unavailable' };
  }
  if (!signaturesEqual(signPayload(payload, secret), token.signature)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  let nowMs: number;
  try {
    nowMs = check.now !== undefined ? toEpochMs(check.now) : Date.now();
  } catch {
    return { ok: false, reason: 'invalid_check' };
  }
  if (!Number.isFinite(nowMs)) return { ok: false, reason: 'invalid_check' };
  try {
    if (toEpochMs(payload.expires_at) <= nowMs) {
      return { ok: false, reason: 'expired' };
    }
  } catch {
    return { ok: false, reason: 'malformed_token' };
  }

  const scopeProvided = check.partition !== undefined || check.tier !== undefined;
  const requiredPartition = normalizePartition(check);
  if (scopeProvided && !requiredPartition) {
    return { ok: false, reason: 'invalid_check' };
  }
  if (requiredPartition && payload.partition !== requiredPartition) {
    return { ok: false, reason: 'partition_mismatch' };
  }

  if (!payload.ops.includes(check.op)) {
    return { ok: false, reason: 'op_not_granted' };
  }

  return { ok: true };
}

/** Assert a 'write' grant for a partition; throws on any validation failure. */
export function assertMemoryWriteCapability(
  token: unknown,
  partition: string,
  options?: Pick<MemoryCapabilityTokenOptions, 'secret'> & {
    now?: Date | number | string;
  }
): MemoryCapabilityTokenPayload {
  const result = validateMemoryCapabilityToken(
    token,
    { partition, op: 'write', now: options?.now },
    options
  );
  if (!result.ok) {
    throw new Error(
      `[MEMORY_CAPABILITY_DENIED] write to partition '${partition}' denied: ${result.reason}`
    );
  }
  return readPayload(token)!;
}
