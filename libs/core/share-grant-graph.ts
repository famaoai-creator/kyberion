import { appendJsonLine, parseSafeJsonInput } from './foundation/json.js';
import { isRecord } from './foundation/text.js';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { auditChain } from './audit-chain.js';
import { computeLedgerEntryHash, GENESIS_HASH } from './chain-integrity.js';
import { pathResolver } from './path-resolver.js';
import { logger } from './core.js';
import {
  safeChmodSync,
  safeCreateExclusiveFileSync,
  safeExistsSync,
  safeFsyncFile,
  safeMkdir,
  safeReadFile,
  assertSafeRepositoryPath,
} from './secure-io.js';
import { withLockSync } from './src/lock-utils.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { isVitestProcess } from './foundation/env.js';
import {
  assertProvenanceShareAllowed,
  combineProvenanceTaint,
  ProvenanceTaintPolicyError,
} from './provenance-taint.js';
import type { ProvenanceTaint } from './cloudflare-os-control-plane.js';

/**
 * OS-13 capability sharing foundation.
 *
 * The graph is intentionally resource-local and fail-closed: the owner is
 * the only root, effective access is recalculated from active edges on every
 * read, and revocation marks an edge disconnected instead of deleting it.
 * Re-granting the same relationship therefore restores descendants without
 * resurrecting a revoked record.
 */

export const SHARE_GRANT_TAINTS = ['personal', 'confidential', 'public'] as const;
export type ShareGrantTaint = (typeof SHARE_GRANT_TAINTS)[number];

export const SHARE_GRANT_ROLES = ['view', 'operate'] as const;
export type ShareGrantRole = (typeof SHARE_GRANT_ROLES)[number];

export const SHARE_LINK_DEFAULT_TTL_MS = 60 * 60 * 1000;
export const SHARE_LINK_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SHARE_GRANTS_PATH_ENV = 'KYBERION_SHARE_GRANTS_PATH';
export const SHARE_GRANTS_HMAC_KEY_ENV = 'KYBERION_SHARE_GRANTS_HMAC_KEY';
export const SHARE_GRANTS_STORE_PATH = pathResolver.shared('coordination/share-grants.jsonl');

const SHARE_GRANTS_HMAC_KEY_PATH = pathResolver.shared('runtime/share-grants/hmac-key');
const SHARE_LINK_PREFIX = 'share-link:';

const ROLE_RANK: Record<ShareGrantRole, number> = { view: 1, operate: 2 };
const TAINT_RANK: Record<ShareGrantTaint, number> = {
  public: 0,
  confidential: 1,
  personal: 2,
};

export interface ShareEdge {
  edgeId: string;
  resourceRef: string;
  grantor: string;
  grantee: string;
  granteeTenantSlug: string;
  role: ShareGrantRole;
  audienceFloor: ShareGrantTaint;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string;
}

export interface ShareResource {
  resourceRef: string;
  tenantSlug: string;
  ownerPrincipal: string;
  taint: ShareGrantTaint;
  provenanceMissionId?: string;
  registeredAt: string;
}

export interface ShareLinkSummary {
  linkId: string;
  resourceRef: string;
  role: ShareGrantRole;
  audienceFloor: ShareGrantTaint;
  grantedBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface ShareGrantLiveSessionEvictionRequest {
  linkId: string;
  resourceRef: string;
  revokedAt: string;
}

export interface ShareGrantLiveSessionRegistration {
  sessionId: string;
  linkId: string;
  resourceRef: string;
  connectedAt: string;
}

export interface ShareGrantLiveSessionSummary extends ShareGrantLiveSessionRegistration {}

export interface ShareGrantLiveSessionEvictionResult {
  evictedSessionIds: string[];
}

export interface ShareGrantLiveSessionEvictor {
  /** Register only after the graph has validated the share-link token. */
  registerShareLinkSession(input: ShareGrantLiveSessionRegistration): ShareGrantLiveSessionSummary;
  /** Evict all active sessions scoped to the revoked share link. */
  evictShareLinkSessions(
    input: ShareGrantLiveSessionEvictionRequest
  ): ShareGrantLiveSessionEvictionResult;
}

export interface EffectiveShareAccess {
  principal: string;
  role: ShareGrantRole;
  audienceFloor: ShareGrantTaint;
}

export interface IssuedShareLink extends ShareLinkSummary {
  /** The plaintext token is returned once and is never persisted. */
  token: string;
}

export interface ShareGrantAuditEvent {
  action: 'resource_registered' | 'edge_granted' | 'edge_revoked' | 'link_issued' | 'link_revoked';
  actor: string;
  resourceRef: string;
  edgeId?: string;
  linkId?: string;
  role?: ShareGrantRole;
}

type ShareGrantAuditSink = (event: ShareGrantAuditEvent) => void;

type PersistedEvent =
  | { type: 'resource_registered'; resource: ShareResource }
  | { type: 'edge_granted'; edge: ShareEdge }
  | { type: 'edge_revoked'; edgeId: string; revokedAt: string }
  | { type: 'link_issued'; link: StoredShareLink; edge: ShareEdge }
  | { type: 'link_revoked'; linkId: string; revokedAt: string };

interface PersistedEnvelope {
  version: 1;
  previousHash: string;
  event: PersistedEvent;
  hash: string;
}

interface StoredShareLink extends ShareLinkSummary {
  tokenHash: string;
}

interface ReachableAccess {
  role: ShareGrantRole;
  audienceFloor: ShareGrantTaint;
}

function persistedString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`share-grant ledger ${key} must be a non-empty string`);
  }
  return value;
}

function persistedOptionalString(record: Record<string, unknown>, key: string): void {
  if (record[key] !== undefined) persistedString(record, key);
}

function persistedRole(record: Record<string, unknown>, key: string): void {
  const value = persistedString(record, key);
  if (!(SHARE_GRANT_ROLES as readonly string[]).includes(value)) {
    throw new Error(`share-grant ledger ${key} is invalid`);
  }
}

function persistedTaint(record: Record<string, unknown>, key: string): void {
  const value = persistedString(record, key);
  if (!(SHARE_GRANT_TAINTS as readonly string[]).includes(value)) {
    throw new Error(`share-grant ledger ${key} is invalid`);
  }
}

function validatePersistedResource(value: unknown): void {
  if (!isRecord(value)) throw new Error('invalid share-grant resource');
  persistedString(value, 'resourceRef');
  persistedString(value, 'tenantSlug');
  persistedString(value, 'ownerPrincipal');
  persistedTaint(value, 'taint');
  persistedString(value, 'registeredAt');
  persistedOptionalString(value, 'provenanceMissionId');
}

function validatePersistedEdge(value: unknown): void {
  if (!isRecord(value)) throw new Error('invalid share-grant edge');
  persistedString(value, 'edgeId');
  persistedString(value, 'resourceRef');
  persistedString(value, 'grantor');
  persistedString(value, 'grantee');
  persistedString(value, 'granteeTenantSlug');
  persistedRole(value, 'role');
  persistedTaint(value, 'audienceFloor');
  persistedString(value, 'grantedBy');
  persistedString(value, 'grantedAt');
  persistedOptionalString(value, 'revokedAt');
}

function validatePersistedLink(value: unknown): void {
  if (!isRecord(value)) throw new Error('invalid share-grant link');
  persistedString(value, 'linkId');
  persistedString(value, 'resourceRef');
  persistedRole(value, 'role');
  persistedTaint(value, 'audienceFloor');
  persistedString(value, 'grantedBy');
  persistedString(value, 'createdAt');
  persistedString(value, 'expiresAt');
  persistedString(value, 'tokenHash');
  persistedOptionalString(value, 'revokedAt');
}

function validatePersistedEvent(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('invalid share-grant ledger event');
  }
  switch (value.type) {
    case 'resource_registered':
      validatePersistedResource(value.resource);
      return;
    case 'edge_granted':
      validatePersistedEdge(value.edge);
      return;
    case 'edge_revoked':
      persistedString(value, 'edgeId');
      persistedString(value, 'revokedAt');
      return;
    case 'link_issued':
      validatePersistedLink(value.link);
      validatePersistedEdge(value.edge);
      return;
    case 'link_revoked':
      persistedString(value, 'linkId');
      persistedString(value, 'revokedAt');
      return;
    default:
      throw new Error('unknown share-grant ledger event');
  }
}

/** Validate a persisted ledger envelope without changing its JSON property order. */
export function parsePersistedEnvelope(value: unknown): PersistedEnvelope {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('invalid share-grant ledger envelope');
  }
  persistedString(value, 'previousHash');
  persistedString(value, 'hash');
  validatePersistedEvent(value.event);
  return value as unknown as PersistedEnvelope;
}

export class ShareGrantValidationError extends Error {
  constructor(message: string) {
    super(`[share-grant-graph] ${message}`);
    this.name = 'ShareGrantValidationError';
  }
}

export class ShareGrantAuthorizationError extends Error {
  constructor(message: string) {
    super(`[share-grant-graph] ${message}`);
    this.name = 'ShareGrantAuthorizationError';
  }
}

export interface ShareGrantGraphOptions {
  storePath?: string;
  hmacKey?: string;
  persist?: boolean;
  now?: () => number;
  auditSink?: ShareGrantAuditSink;
  authorizeActor?: ShareGrantAuthorizer;
  /** Canonical tenant registry resolver; every mutation must resolve active. */
  resolveTenant?: (tenantSlug: string) => { status: 'active' | 'suspended' | 'archived' } | null;
  /** Re-resolve observation-derived provenance by mission for each access. */
  resolveProvenance?: (missionId: string) => ProvenanceTaint | null;
  /** Revoke active sessions after the durable link-revocation event is appended. */
  liveSessionEvictor?: ShareGrantLiveSessionEvictor;
}

export interface ShareGrantActor {
  principalId: string;
  authenticated: true;
  tenantSlugs: readonly string[] | 'all';
}

export interface ShareGrantAuthorizationRequest {
  operation: 'register_resource' | 'grant_edge' | 'revoke_edge' | 'issue_link' | 'revoke_link';
  actor: ShareGrantActor;
  resourceRef: string;
  tenantSlug: string;
  ownerPrincipal?: string;
  targetPrincipal?: string;
  targetTenantSlug?: string;
}

/** The embedding surface must bind this request to its trusted viewer/tenant context. */
export type ShareGrantAuthorizer = (request: ShareGrantAuthorizationRequest) => void;

function assertNonEmpty(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new ShareGrantValidationError(`${label} is required`);
  if (normalized.length > 512) {
    throw new ShareGrantValidationError(`${label} exceeds the 512-character limit`);
  }
  return normalized;
}

function assertPrincipal(value: string, label: string): string {
  const principal = assertNonEmpty(value, label);
  if (principal.startsWith(SHARE_LINK_PREFIX)) {
    throw new ShareGrantValidationError(`${label} cannot be a share-link subject`);
  }
  return principal;
}

function assertTaint(value: string, label: string): asserts value is ShareGrantTaint {
  if (!(SHARE_GRANT_TAINTS as readonly string[]).includes(value)) {
    throw new ShareGrantValidationError(`${label} must be one of ${SHARE_GRANT_TAINTS.join(', ')}`);
  }
}

function assertRole(value: string, label: string): asserts value is ShareGrantRole {
  if (!(SHARE_GRANT_ROLES as readonly string[]).includes(value)) {
    throw new ShareGrantValidationError(`${label} must be one of ${SHARE_GRANT_ROLES.join(', ')}`);
  }
}

function moreRestrictiveTaint(left: ShareGrantTaint, right: ShareGrantTaint): ShareGrantTaint {
  return TAINT_RANK[left] >= TAINT_RANK[right] ? left : right;
}

function isRoleAtLeast(actual: ShareGrantRole, required: ShareGrantRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

function resolveStorePath(): string {
  const configuredPath = getRegisteredEnvText(SHARE_GRANTS_PATH_ENV)?.trim();
  const configured = configuredPath
    ? pathResolver.rootResolve(configuredPath)
    : SHARE_GRANTS_STORE_PATH;
  return assertSafeRepositoryPath(configured, { allowMissingLeaf: true });
}

function resolveDefaultHmacKey(): string {
  const fromEnv = getRegisteredEnvText(SHARE_GRANTS_HMAC_KEY_ENV)?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new ShareGrantValidationError(
        `${SHARE_GRANTS_HMAC_KEY_ENV} must contain at least 32 characters`
      );
    }
    return fromEnv;
  }

  if (safeExistsSync(SHARE_GRANTS_HMAC_KEY_PATH)) {
    const persisted = String(safeReadFile(SHARE_GRANTS_HMAC_KEY_PATH, { encoding: 'utf8' })).trim();
    if (persisted) {
      if (persisted.length < 32) {
        throw new ShareGrantValidationError('persisted share-link HMAC key is too short');
      }
      return persisted;
    }
  }

  const generated = randomBytes(32).toString('hex');
  const dir = path.dirname(SHARE_GRANTS_HMAC_KEY_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  try {
    safeCreateExclusiveFileSync(SHARE_GRANTS_HMAC_KEY_PATH, `${generated}\n`);
    safeChmodSync(SHARE_GRANTS_HMAC_KEY_PATH, 0o600);
    return generated;
  } catch {
    if (safeExistsSync(SHARE_GRANTS_HMAC_KEY_PATH)) {
      const persisted = String(
        safeReadFile(SHARE_GRANTS_HMAC_KEY_PATH, { encoding: 'utf8' })
      ).trim();
      if (persisted) {
        if (persisted.length < 32) {
          throw new ShareGrantValidationError('persisted share-link HMAC key is too short');
        }
        return persisted;
      }
    }
    throw new ShareGrantValidationError('share-link HMAC key could not be persisted');
  }
}

function assertHmacKey(key: string, label: string): string {
  const normalized = key.trim();
  if (normalized.length < 32) {
    throw new ShareGrantValidationError(`${label} must contain at least 32 characters`);
  }
  return normalized;
}

function hashShareToken(token: string, hmacKey: string): string {
  return createHmac('sha256', hmacKey).update(token).digest('hex');
}

function sameHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isActiveAt(timestamp: string | undefined, now: number): boolean {
  return !timestamp || Date.parse(timestamp) > now;
}

export class ShareGrantGraph {
  readonly #storePath: string;
  readonly #persist: boolean;
  readonly #now: () => number;
  readonly #hmacKey: string | undefined;
  readonly #auditSink: ShareGrantAuditSink | undefined;
  readonly #authorizeActor: ShareGrantAuthorizer | undefined;
  readonly #resolveTenant: ShareGrantGraphOptions['resolveTenant'];
  readonly #resolveProvenance: ShareGrantGraphOptions['resolveProvenance'];
  readonly #liveSessionEvictor: ShareGrantLiveSessionEvictor | undefined;
  #lastLedgerHash = GENESIS_HASH;
  readonly #resources = new Map<string, ShareResource>();
  readonly #edges = new Map<string, ShareEdge>();
  readonly #links = new Map<string, StoredShareLink>();

  constructor(options: ShareGrantGraphOptions = {}) {
    this.#storePath = assertSafeRepositoryPath(options.storePath ?? resolveStorePath(), {
      allowMissingLeaf: true,
    });
    this.#persist = options.persist ?? true;
    this.#now = options.now ?? Date.now;
    this.#hmacKey = options.hmacKey ? assertHmacKey(options.hmacKey, 'hmacKey') : undefined;
    this.#auditSink = options.auditSink;
    this.#authorizeActor = options.authorizeActor;
    this.#resolveTenant = options.resolveTenant;
    this.#resolveProvenance = options.resolveProvenance;
    this.#liveSessionEvictor = options.liveSessionEvictor;
    if (this.#persist) this.#load();
  }

  registerResource(params: {
    resourceRef: string;
    tenantSlug: string;
    ownerPrincipal?: string;
    taint: ShareGrantTaint;
    actor: ShareGrantActor;
    provenanceMissionId?: string;
  }): ShareResource {
    const resourceRef = assertNonEmpty(params.resourceRef, 'resourceRef');
    const tenantSlug = assertNonEmpty(params.tenantSlug, 'tenantSlug');
    const actorPrincipal = this.#assertActor('register_resource', params.actor, resourceRef, {
      tenantSlug,
      ownerPrincipal: params.ownerPrincipal,
    });
    const ownerPrincipal = assertPrincipal(
      params.ownerPrincipal || actorPrincipal,
      'ownerPrincipal'
    );
    if (ownerPrincipal !== actorPrincipal) {
      throw new ShareGrantAuthorizationError(
        'resource ownerPrincipal must match the authenticated actor principal'
      );
    }
    assertTaint(params.taint, 'taint');
    if (params.provenanceMissionId && !this.#resolveProvenance) {
      throw new ShareGrantAuthorizationError(
        'provenanceMissionId requires a trusted provenance resolver'
      );
    }
    const provenance = params.provenanceMissionId
      ? this.#resolveProvenance?.(params.provenanceMissionId) || null
      : null;
    if (params.provenanceMissionId && !provenance) {
      throw new ShareGrantAuthorizationError(
        `provenance mission ${params.provenanceMissionId} could not be resolved`
      );
    }
    assertProvenanceShareAllowed({
      provenance,
      audienceFloor: combineProvenanceTaint(params.taint, provenance),
      targetTenant: tenantSlug,
      external: false,
    });
    const existing = this.#resources.get(resourceRef);
    if (existing) {
      if (
        existing.tenantSlug !== tenantSlug ||
        existing.ownerPrincipal !== ownerPrincipal ||
        existing.taint !== params.taint ||
        existing.provenanceMissionId !== params.provenanceMissionId
      ) {
        throw new ShareGrantValidationError(
          `resource ${resourceRef} is already registered with a different owner or taint`
        );
      }
      return this.getResource(resourceRef)!;
    }

    const resource: ShareResource = {
      resourceRef,
      tenantSlug,
      ownerPrincipal,
      taint: params.taint,
      ...(params.provenanceMissionId ? { provenanceMissionId: params.provenanceMissionId } : {}),
      registeredAt: new Date(this.#now()).toISOString(),
    };
    this.#append({ type: 'resource_registered', resource });
    this.#resources.set(resourceRef, resource);
    this.#audit({
      action: 'resource_registered',
      actor: actorPrincipal,
      resourceRef,
    });
    return this.getResource(resourceRef)!;
  }

  getResource(resourceRef: string): ShareResource | null {
    const resource = this.#resources.get(assertNonEmpty(resourceRef, 'resourceRef'));
    return resource
      ? {
          ...resource,
          taint: combineProvenanceTaint(resource.taint, this.#resourceProvenance(resource)),
        }
      : null;
  }

  grantEdge(params: {
    resourceRef: string;
    actor: ShareGrantActor;
    grantee: string;
    role: ShareGrantRole;
    audienceFloor?: ShareGrantTaint;
    targetTenantSlug?: string;
  }): ShareEdge {
    const resource = this.#requireResource(params.resourceRef);
    const grantor = this.#assertActor('grant_edge', params.actor, resource.resourceRef, {
      tenantSlug: resource.tenantSlug,
      targetPrincipal: params.grantee,
      targetTenantSlug: params.targetTenantSlug ?? resource.tenantSlug,
    });
    const grantee = assertPrincipal(params.grantee, 'grantee');
    if (grantor === grantee) throw new ShareGrantValidationError('grantor and grantee must differ');
    assertRole(params.role, 'role');
    const audienceFloor = params.audienceFloor ?? resource.taint;
    assertTaint(audienceFloor, 'audienceFloor');
    this.#assertTaintDoesNotBroaden(resource.taint, audienceFloor);
    assertProvenanceShareAllowed({
      provenance: this.#resourceProvenance(resource),
      audienceFloor,
      targetTenant: params.targetTenantSlug ?? resource.tenantSlug,
      external: false,
    });
    this.#assertCanOperate(resource, grantor);

    const edge: ShareEdge = {
      edgeId: `sg-${this.#now().toString(36)}-${randomUUID().slice(0, 8)}`,
      resourceRef: resource.resourceRef,
      grantor,
      grantee,
      granteeTenantSlug: params.targetTenantSlug ?? resource.tenantSlug,
      role: params.role,
      audienceFloor,
      grantedBy: grantor,
      grantedAt: new Date(this.#now()).toISOString(),
    };
    this.#append({ type: 'edge_granted', edge });
    this.#edges.set(edge.edgeId, edge);
    this.#audit({
      action: 'edge_granted',
      actor: edge.grantedBy,
      resourceRef: edge.resourceRef,
      edgeId: edge.edgeId,
      role: edge.role,
    });
    return { ...edge };
  }

  revokeEdge(edgeId: string, actor: ShareGrantActor): ShareEdge {
    const edge = this.#edges.get(assertNonEmpty(edgeId, 'edgeId'));
    if (!edge) throw new ShareGrantValidationError(`edge ${edgeId} was not found`);
    const resource = this.#requireResource(edge.resourceRef);
    const actorPrincipal = this.#assertActor('revoke_edge', actor, edge.resourceRef, {
      tenantSlug: resource.tenantSlug,
    });
    this.#assertCanOperate(resource, actorPrincipal);
    if (edge.revokedAt) return { ...edge };
    const revokedAt = new Date(this.#now()).toISOString();
    const revoked = { ...edge, revokedAt };
    this.#append({ type: 'edge_revoked', edgeId: edge.edgeId, revokedAt });
    this.#edges.set(edge.edgeId, revoked);
    this.#audit({
      action: 'edge_revoked',
      actor: actorPrincipal,
      resourceRef: edge.resourceRef,
      edgeId: edge.edgeId,
      role: edge.role,
    });
    return { ...revoked };
  }

  issueShareLink(params: {
    resourceRef: string;
    actor: ShareGrantActor;
    role: ShareGrantRole;
    audienceFloor?: ShareGrantTaint;
    expiresAt?: string;
    ttlMs?: number;
  }): IssuedShareLink {
    const resource = this.#requireResource(params.resourceRef);
    const grantedBy = this.#assertActor('issue_link', params.actor, resource.resourceRef, {
      tenantSlug: resource.tenantSlug,
    });
    assertRole(params.role, 'role');
    this.#assertCanOperate(resource, grantedBy);
    const audienceFloor = params.audienceFloor ?? resource.taint;
    assertTaint(audienceFloor, 'audienceFloor');
    this.#assertTaintDoesNotBroaden(resource.taint, audienceFloor);
    assertProvenanceShareAllowed({
      provenance: this.#resourceProvenance(resource),
      audienceFloor,
      targetTenant: resource.tenantSlug,
      external: true,
    });

    const now = this.#now();
    const requestedExpiry = params.expiresAt
      ? Date.parse(params.expiresAt)
      : now + (params.ttlMs ?? SHARE_LINK_DEFAULT_TTL_MS);
    if (!Number.isFinite(requestedExpiry) || requestedExpiry <= now) {
      throw new ShareGrantValidationError('share-link expiry must be in the future');
    }
    const expiresAt = new Date(
      Math.min(requestedExpiry, now + SHARE_LINK_MAX_TTL_MS)
    ).toISOString();
    const token = randomBytes(16).toString('base64url');
    const linkId = `sl-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
    const link: StoredShareLink = {
      linkId,
      resourceRef: resource.resourceRef,
      role: params.role,
      audienceFloor,
      grantedBy,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      tokenHash: hashShareToken(token, this.#resolveHmacKey()),
    };
    const edge = this.#buildLinkEdge(resource, link, grantedBy);
    this.#append({ type: 'link_issued', link, edge });
    this.#links.set(linkId, link);
    this.#edges.set(edge.edgeId, edge);
    this.#audit({
      action: 'link_issued',
      actor: grantedBy,
      resourceRef: resource.resourceRef,
      edgeId: edge.edgeId,
      linkId,
      role: params.role,
    });
    return { ...this.#publicLink(link), token };
  }

  revokeShareLink(linkId: string, actor: ShareGrantActor): ShareLinkSummary {
    const link = this.#links.get(assertNonEmpty(linkId, 'linkId'));
    if (!link) throw new ShareGrantValidationError(`share-link ${linkId} was not found`);
    const resource = this.#requireResource(link.resourceRef);
    const actorPrincipal = this.#assertActor('revoke_link', actor, link.resourceRef, {
      tenantSlug: resource.tenantSlug,
    });
    this.#assertCanOperate(resource, actorPrincipal);
    if (link.revokedAt) {
      this.#evictLiveSessions(link, link.revokedAt);
      return this.#publicLink(link);
    }
    const revokedAt = new Date(this.#now()).toISOString();
    const revoked = { ...link, revokedAt };
    this.#append({ type: 'link_revoked', linkId: link.linkId, revokedAt });
    this.#links.set(link.linkId, revoked);
    this.#evictLiveSessions(revoked, revokedAt);
    this.#audit({
      action: 'link_revoked',
      actor: actorPrincipal,
      resourceRef: link.resourceRef,
      linkId: link.linkId,
      role: link.role,
    });
    return this.#publicLink(revoked);
  }

  /**
   * Establish a live session only after resolving the current share-link
   * token. The registry never receives the token; it receives the validated
   * link scope only.
   */
  openShareLinkSession(params: {
    resourceRef: string;
    token: string;
    sessionId: string;
    connectedAt: string;
  }): ShareGrantLiveSessionSummary | null {
    if (!this.#liveSessionEvictor) {
      throw new ShareGrantAuthorizationError(
        'live share-link sessions require a trusted live-session registry'
      );
    }
    const access = this.resolveShareLink(params.resourceRef, params.token);
    if (!access) return null;
    const linkId = access.principal.startsWith(SHARE_LINK_PREFIX)
      ? access.principal.slice(SHARE_LINK_PREFIX.length)
      : '';
    const link = this.#links.get(linkId);
    if (!link || link.resourceRef !== params.resourceRef || link.revokedAt) return null;
    return this.#liveSessionEvictor.registerShareLinkSession({
      sessionId: params.sessionId,
      linkId,
      resourceRef: link.resourceRef,
      connectedAt: params.connectedAt,
    });
  }

  getEffectiveAccess(resourceRef: string, principal: string): EffectiveShareAccess | null {
    const resource = this.#requireResource(resourceRef);
    const subject = assertNonEmpty(principal, 'principal');
    if (subject.startsWith(SHARE_LINK_PREFIX)) {
      throw new ShareGrantValidationError(
        'share-link subjects must be resolved with resolveShareLink, not addressed directly'
      );
    }
    const access = this.#reachable(resource).get(subject);
    if (!access) return null;
    return {
      principal: subject,
      role: access.role,
      audienceFloor: access.audienceFloor,
    };
  }

  resolveShareLink(resourceRef: string, token: string): EffectiveShareAccess | null {
    const resource = this.#requireResource(resourceRef);
    const candidate = assertNonEmpty(token, 'token');
    const now = this.#now();
    const link = [...this.#links.values()].find(
      (item) =>
        item.resourceRef === resource.resourceRef &&
        !item.revokedAt &&
        Date.parse(item.expiresAt) > now &&
        sameHash(item.tokenHash, hashShareToken(candidate, this.#resolveHmacKey()))
    );
    if (!link) return null;
    try {
      assertProvenanceShareAllowed({
        provenance: this.#resourceProvenance(resource),
        audienceFloor: link.audienceFloor,
        targetTenant: resource.tenantSlug,
        external: true,
      });
    } catch (error) {
      if (error instanceof ProvenanceTaintPolicyError) return null;
      throw error;
    }
    const access = this.#reachable(resource).get(this.#linkSubject(link.linkId));
    if (!access) return null;
    return {
      principal: this.#linkSubject(link.linkId),
      role: access.role,
      audienceFloor: moreRestrictiveTaint(access.audienceFloor, link.audienceFloor),
    };
  }

  listEdges(resourceRef?: string): ShareEdge[] {
    const filter = resourceRef?.trim();
    return [...this.#edges.values()]
      .filter((edge) => !filter || edge.resourceRef === filter)
      .map((edge) => ({ ...edge }));
  }

  listShareLinks(resourceRef?: string): ShareLinkSummary[] {
    const filter = resourceRef?.trim();
    return [...this.#links.values()]
      .filter((link) => !filter || link.resourceRef === filter)
      .map((link) => this.#publicLink(link));
  }

  #assertActor(
    operation: ShareGrantAuthorizationRequest['operation'],
    actor: ShareGrantActor,
    resourceRef: string,
    details: Pick<
      ShareGrantAuthorizationRequest,
      'tenantSlug' | 'ownerPrincipal' | 'targetPrincipal' | 'targetTenantSlug'
    >
  ): string {
    if (!actor || actor.authenticated !== true) {
      throw new ShareGrantAuthorizationError(
        `${operation} requires an authenticated actor context`
      );
    }
    const principalId = assertPrincipal(actor.principalId, 'actor.principalId');
    if (!this.#authorizeActor) {
      throw new ShareGrantAuthorizationError(
        `${operation} requires a trusted ShareGrantAuthorizer`
      );
    }
    if (!this.#resolveTenant) {
      throw new ShareGrantAuthorizationError(
        `${operation} requires a trusted tenant registry resolver`
      );
    }
    const tenant = this.#resolveTenant(details.tenantSlug);
    if (!tenant || tenant.status !== 'active') {
      throw new ShareGrantAuthorizationError(
        `share grant tenant ${details.tenantSlug} is not active`
      );
    }
    if (actor.tenantSlugs !== 'all' && !actor.tenantSlugs.includes(details.tenantSlug)) {
      throw new ShareGrantAuthorizationError(
        `${operation} actor is outside tenant scope ${details.tenantSlug}`
      );
    }
    this.#authorizeActor({
      operation,
      actor: { ...actor, principalId },
      resourceRef,
      ...details,
    });
    return principalId;
  }

  #requireResource(resourceRef: string): ShareResource {
    const resource = this.#resources.get(assertNonEmpty(resourceRef, 'resourceRef'));
    if (!resource)
      throw new ShareGrantValidationError(`resource ${resourceRef} was not registered`);
    return {
      ...resource,
      taint: combineProvenanceTaint(resource.taint, this.#resourceProvenance(resource)),
    };
  }

  #resourceProvenance(resource: ShareResource): ProvenanceTaint | null {
    if (!resource.provenanceMissionId) return null;
    if (!this.#resolveProvenance) {
      throw new ShareGrantAuthorizationError(
        'resource provenance requires a trusted provenance resolver'
      );
    }
    const provenance = this.#resolveProvenance(resource.provenanceMissionId);
    if (!provenance) {
      throw new ShareGrantAuthorizationError(
        `provenance mission ${resource.provenanceMissionId} could not be resolved`
      );
    }
    return provenance;
  }

  #assertTaintDoesNotBroaden(resourceTaint: ShareGrantTaint, audienceFloor: ShareGrantTaint): void {
    if (TAINT_RANK[audienceFloor] < TAINT_RANK[resourceTaint]) {
      throw new ShareGrantAuthorizationError(
        `audience floor ${audienceFloor} would broaden ${resourceTaint} taint`
      );
    }
  }

  #assertCanOperate(resource: ShareResource, principal: string): void {
    if (principal === resource.ownerPrincipal) return;
    const access = this.#reachable(resource).get(principal);
    if (!access || !isRoleAtLeast(access.role, 'operate')) {
      throw new ShareGrantAuthorizationError(
        `${principal} does not have operate access to ${resource.resourceRef}`
      );
    }
  }

  #buildLinkEdge(resource: ShareResource, link: StoredShareLink, grantedBy: string): ShareEdge {
    return {
      edgeId: `sg-${this.#now().toString(36)}-${randomUUID().slice(0, 8)}`,
      resourceRef: resource.resourceRef,
      grantor: grantedBy,
      grantee: this.#linkSubject(link.linkId),
      granteeTenantSlug: resource.tenantSlug,
      role: link.role,
      audienceFloor: link.audienceFloor,
      grantedBy,
      grantedAt: link.createdAt,
    };
  }

  #linkSubject(linkId: string): string {
    return `${SHARE_LINK_PREFIX}${linkId}`;
  }

  #evictLiveSessions(link: StoredShareLink, revokedAt: string): void {
    if (!this.#liveSessionEvictor) return;
    // The ledger append above is deliberately the first durable side effect.
    // If the evictor fails, the link remains revoked and a later revoke call
    // retries the eviction because revoked links still pass through this hook.
    this.#liveSessionEvictor.evictShareLinkSessions({
      linkId: link.linkId,
      resourceRef: link.resourceRef,
      revokedAt,
    });
  }

  #reachable(resource: ShareResource): Map<string, ReachableAccess> {
    const reachable = new Map<string, ReachableAccess>([
      [resource.ownerPrincipal, { role: 'operate', audienceFloor: resource.taint }],
    ]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of this.#edges.values()) {
        if (
          edge.resourceRef !== resource.resourceRef ||
          edge.revokedAt ||
          !isActiveAt(edge.revokedAt, this.#now())
        ) {
          continue;
        }
        const parent = reachable.get(edge.grantor);
        if (!parent) continue;
        const next: ReachableAccess = {
          role: edge.role,
          audienceFloor: moreRestrictiveTaint(parent.audienceFloor, edge.audienceFloor),
        };
        const previous = reachable.get(edge.grantee);
        if (
          !previous ||
          ROLE_RANK[next.role] > ROLE_RANK[previous.role] ||
          TAINT_RANK[next.audienceFloor] > TAINT_RANK[previous.audienceFloor]
        ) {
          reachable.set(edge.grantee, next);
          changed = true;
        }
      }
    }
    return reachable;
  }

  #resolveHmacKey(): string {
    return this.#hmacKey || resolveDefaultHmacKey();
  }

  #publicLink(link: StoredShareLink): ShareLinkSummary {
    const { tokenHash: _tokenHash, ...publicLink } = link;
    return { ...publicLink };
  }

  #audit(event: ShareGrantAuditEvent): void {
    try {
      if (this.#auditSink) {
        this.#auditSink(event);
      } else if (!isVitestProcess()) {
        auditChain.record({
          agentId: event.actor,
          action: `share_grant_${event.action}`,
          operation: event.resourceRef,
          result: 'completed',
          metadata: {
            resourceRef: event.resourceRef,
            ...(event.edgeId ? { edgeId: event.edgeId } : {}),
            ...(event.linkId ? { linkId: event.linkId } : {}),
            ...(event.role ? { role: event.role } : {}),
          },
        });
      }
    } catch {
      // The hash-chained graph ledger is authoritative. The audit-chain is a
      // supplemental forwarder, so its outage must not roll back a durable
      // graph mutation, but the failure must remain operationally visible.
      logger.warn('[share-grant-graph] supplemental audit-chain append failed');
    }
  }

  #append(event: PersistedEvent): void {
    if (!this.#persist) return;
    const dir = path.dirname(this.#storePath);
    withLockSync('share-grant-graph', () => {
      if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
      const previousHash = this.#readVerifiedTailHash();
      const unsignedEnvelope = {
        version: 1 as const,
        previousHash,
        event,
      };
      const hash = computeLedgerEntryHash(unsignedEnvelope, {
        alg: 'hmac-sha256',
        key: this.#resolveHmacKey(),
      });
      const envelope: PersistedEnvelope = { ...unsignedEnvelope, hash };
      appendJsonLine(this.#storePath, envelope);
      safeFsyncFile(this.#storePath);
      this.#lastLedgerHash = hash;
    });
  }

  #load(): void {
    if (!safeExistsSync(this.#storePath)) return;
    const raw = String(safeReadFile(this.#storePath, { encoding: 'utf8' }));
    let previousHash = GENESIS_HASH;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const envelope = parsePersistedEnvelope(
          parseSafeJsonInput(trimmed, 'share-grant ledger entry')
        );
        this.#verifyEnvelope(envelope, previousHash);
        this.#apply(envelope.event);
        previousHash = envelope.hash;
      } catch (error) {
        throw new ShareGrantValidationError(
          `share-grant ledger integrity check failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    this.#lastLedgerHash = previousHash;
  }

  #readVerifiedTailHash(): string {
    if (!safeExistsSync(this.#storePath)) return GENESIS_HASH;
    const raw = String(safeReadFile(this.#storePath, { encoding: 'utf8' }));
    let previousHash = GENESIS_HASH;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const envelope = parsePersistedEnvelope(
        parseSafeJsonInput(trimmed, 'share-grant ledger entry')
      );
      this.#verifyEnvelope(envelope, previousHash);
      previousHash = envelope.hash;
    }
    return previousHash;
  }

  #verifyEnvelope(envelope: PersistedEnvelope, previousHash: string): void {
    if (envelope?.version !== 1 || envelope.previousHash !== previousHash) {
      throw new Error('share-grant ledger previous hash mismatch');
    }
    const expectedHash = computeLedgerEntryHash(
      {
        version: envelope.version,
        previousHash: envelope.previousHash,
        event: envelope.event,
      },
      {
        alg: 'hmac-sha256',
        key: this.#resolveHmacKey(),
      }
    );
    if (!sameHash(envelope.hash, expectedHash)) {
      throw new Error('share-grant ledger hash mismatch');
    }
  }

  #apply(event: PersistedEvent): void {
    if (!event || typeof event !== 'object') {
      throw new Error('invalid share-grant ledger event');
    }
    switch (event.type) {
      case 'resource_registered':
        if (
          event.resource?.resourceRef &&
          event.resource.tenantSlug &&
          event.resource.ownerPrincipal
        ) {
          this.#resources.set(event.resource.resourceRef, { ...event.resource });
        } else {
          throw new Error('invalid resource_registered event');
        }
        break;
      case 'edge_granted':
        if (event.edge?.edgeId && event.edge.resourceRef && event.edge.granteeTenantSlug) {
          this.#edges.set(event.edge.edgeId, { ...event.edge });
        } else {
          throw new Error('invalid edge_granted event');
        }
        break;
      case 'edge_revoked': {
        if (!event.edgeId || !event.revokedAt) throw new Error('invalid edge_revoked event');
        const edge = this.#edges.get(event.edgeId);
        if (!edge) throw new Error(`edge ${event.edgeId} was not found during replay`);
        this.#edges.set(event.edgeId, { ...edge, revokedAt: event.revokedAt });
        break;
      }
      case 'link_issued':
        if (
          event.link?.linkId &&
          event.link.resourceRef &&
          event.link.tokenHash &&
          event.edge?.edgeId &&
          event.edge.granteeTenantSlug
        ) {
          this.#links.set(event.link.linkId, { ...event.link });
          this.#edges.set(event.edge.edgeId, { ...event.edge });
        } else {
          throw new Error('invalid link_issued event');
        }
        break;
      case 'link_revoked': {
        if (!event.linkId || !event.revokedAt) throw new Error('invalid link_revoked event');
        const link = this.#links.get(event.linkId);
        if (!link) throw new Error(`link ${event.linkId} was not found during replay`);
        const revoked = { ...link, revokedAt: event.revokedAt };
        this.#links.set(event.linkId, revoked);
        // Reconcile an eviction that may have been interrupted after the
        // durable ledger append but before the process exited.
        this.#evictLiveSessions(revoked, event.revokedAt);
        break;
      }
      default:
        throw new Error('unknown share-grant ledger event');
    }
  }
}
