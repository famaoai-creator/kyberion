import {
  CloudflareOsControlPlane,
  type OsKnowledgeTier,
  type HeldActionSummary,
  type ObservationRecord,
} from './cloudflare-os-control-plane.js';
import { redactSensitiveString } from './network.js';

export interface CloudflareOsSurfaceSnapshot {
  missionId?: string;
  heldActions: HeldActionSummary[];
  observations: ObservationRecord[];
}

export interface CloudflareOsSurfaceAccess {
  principalId: string;
  tenantSlugs: readonly string[] | 'all';
  /** Tiers this server-resolved viewer may see; omitted uses the safe default. */
  tierAccess?: readonly OsKnowledgeTier[];
}

export interface CloudflareOsSurfaceDecision {
  id: string;
  decision: 'approved' | 'rejected';
}

const MAX_SURFACE_ITEMS = 50;
const DEFAULT_SURFACE_TIER_ACCESS: readonly OsKnowledgeTier[] = ['public', 'confidential'];
type TenantScopedItem = { tenantSlug?: string };

/**
 * Narrow, human-facing adapter for an authenticated operator surface.
 *
 * The adapter is intentionally the only place a surface needs to know how a
 * decision is bound to the queued action. It returns summaries only and keeps
 * executor parameters/results inside the control plane.
 */
export class CloudflareOsSurface {
  constructor(private readonly controlPlane = new CloudflareOsControlPlane()) {}

  snapshot(
    missionId: string | undefined,
    access: CloudflareOsSurfaceAccess
  ): CloudflareOsSurfaceSnapshot {
    assertSurfaceAccess(access);
    const normalizedMissionId = normalizeOptionalMissionId(missionId);
    return {
      ...(normalizedMissionId ? { missionId: normalizedMissionId } : {}),
      heldActions: this.controlPlane
        .listHeldActionSummaries(normalizedMissionId)
        .filter((item) => isHeldActionVisible(item, access))
        .slice(-MAX_SURFACE_ITEMS)
        .reverse(),
      observations: this.controlPlane
        .listObservations(normalizedMissionId)
        .filter((item) => isObservationVisible(item, access))
        .map((item) => ({
          ...item,
          service: redactSurfaceObservationField(item.service, 80),
          resourceRef: redactSurfaceObservationField(item.resourceRef),
          purpose: redactSurfaceObservationField(item.purpose, 160),
          summary: redactSurfaceObservationField(item.summary),
        }))
        .slice(-MAX_SURFACE_ITEMS)
        .reverse(),
    };
  }

  decideHeldAction(
    id: string,
    decision: CloudflareOsSurfaceDecision['decision'],
    access: CloudflareOsSurfaceAccess
  ): HeldActionSummary {
    assertSurfaceAccess(access);
    const record = this.controlPlane.getHeldAction(id);
    if (!record) throw new Error(`Held action not found: ${id}`);
    assertHeldActionVisible(record, access);
    if (record.status !== 'pending') {
      throw new Error(`Held action ${id} is already ${record.status}`);
    }
    this.controlPlane.decideHeldAction(id, decision, {
      resolvedBy: requireHumanSurfaceActor(access.principalId),
      decidedByType: 'human',
      authenticated: true,
      payloadHash: record.payloadHash,
      effectBinding: record.effectBinding,
    });
    return this.controlPlane.getHeldActionSummary(id)!;
  }

  async applyHeldAction(id: string, access: CloudflareOsSurfaceAccess): Promise<HeldActionSummary> {
    assertSurfaceAccess(access);
    const record = this.controlPlane.getHeldAction(id);
    if (!record) throw new Error(`Held action not found: ${id}`);
    assertHeldActionVisible(record, access);
    if (record.status !== 'approved') {
      throw new Error(`Held action ${id} is not approved (status: ${record.status})`);
    }
    await this.controlPlane.applyHeldAction(id);
    return this.controlPlane.getHeldActionSummary(id)!;
  }
}

/**
 * Default-deny projection wrapper for surfaces that may observe the OS but
 * must never decide or apply a held action. The mutable surface remains
 * available only to the explicitly authorized decision surface.
 */
export class CloudflareOsReadOnlySurface {
  #surface: Pick<CloudflareOsSurface, 'snapshot'>;

  constructor(surface: Pick<CloudflareOsSurface, 'snapshot'> = new CloudflareOsSurface()) {
    this.#surface = surface;
  }

  snapshot(
    missionId: string | undefined,
    access: CloudflareOsSurfaceAccess
  ): CloudflareOsSurfaceSnapshot {
    return this.#surface.snapshot(missionId, access);
  }
}

/**
 * Compile-time registration ceremony for the default-deny projection.
 *
 * A new public method on CloudflareOsSurface must be classified here before
 * typecheck passes. This prevents the read-only boundary from silently
 * drifting when the mutable surface grows.
 */
type CloudflareOsSurfaceMethodRegistry = 'snapshot' | 'decideHeldAction' | 'applyHeldAction';
type CloudflareOsSurfaceMethodRegistryIsComplete =
  Exclude<keyof CloudflareOsSurface, CloudflareOsSurfaceMethodRegistry> extends never
    ? Exclude<CloudflareOsSurfaceMethodRegistry, keyof CloudflareOsSurface> extends never
      ? true
      : false
    : false;
const cloudflareOsSurfaceMethodRegistryCheck: CloudflareOsSurfaceMethodRegistryIsComplete = true;

function assertSurfaceAccess(access: CloudflareOsSurfaceAccess): void {
  if (!access || !String(access.principalId || '').trim()) {
    throw new Error('[POLICY_VIOLATION] Surface viewer principal is required');
  }
  if (
    access.tenantSlugs !== 'all' &&
    (!Array.isArray(access.tenantSlugs) ||
      access.tenantSlugs.some((tenant) => !String(tenant).trim()))
  ) {
    throw new Error('[POLICY_VIOLATION] Surface viewer tenant scope is invalid');
  }
}

function isHeldActionVisible(item: TenantScopedItem, access: CloudflareOsSurfaceAccess): boolean {
  if (access.tenantSlugs === 'all') return true;
  return Boolean(item.tenantSlug && access.tenantSlugs.includes(item.tenantSlug));
}

function assertHeldActionVisible(item: TenantScopedItem, access: CloudflareOsSurfaceAccess): void {
  if (!isHeldActionVisible(item, access)) {
    throw new Error('[POLICY_VIOLATION] Held action is outside the surface tenant scope');
  }
}

function isObservationVisible(item: ObservationRecord, access: CloudflareOsSurfaceAccess): boolean {
  const tenantVisible =
    access.tenantSlugs === 'all'
      ? true
      : item.tenantSlug
        ? access.tenantSlugs.includes(item.tenantSlug)
        : item.tier === 'public';
  const tierVisible = (access.tierAccess ?? DEFAULT_SURFACE_TIER_ACCESS).includes(item.tier);
  return tenantVisible && tierVisible;
}

function normalizeOptionalMissionId(value?: string): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  if (normalized.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw new Error('[POLICY_VIOLATION] Invalid mission_id filter');
  }
  return normalized;
}

function redactSurfaceObservationField(value: string, maxLength = 240): string {
  return redactSensitiveString(value)
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|token|secret|password)=)[^&\s]+/gi,
      '$1[REDACTED_SECRET]'
    )
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, 'Authorization: [REDACTED_SECRET]')
    .replace(/\b(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED_SECRET]')
    .slice(0, maxLength);
}

function requireHumanSurfaceActor(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized.startsWith('human:')) {
    throw new Error('[POLICY_VIOLATION] Surface decisions require a human actor');
  }
  return normalized;
}
