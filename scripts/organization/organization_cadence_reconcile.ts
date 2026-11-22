import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { listDotCharters, type DotCharter } from '@agent/core/dot/dot-charter';
import { createDraftDotCharter, transitionDotCharterStatus } from '@agent/core/dot/dot-lifecycle';
import { loadOrganizationOperationalState } from '@agent/core/organization/organization-operating-model-persistence';
import type { OrganizationOperationalState } from '@agent/core/organization/organization-operating-model';
import { getOperationsHaltState } from '@agent/core/governance/operations-halt';
import { listOrganizationScopes } from '@agent/core/organization/organization-cadence';
import { createLogger } from '@agent/core/logger';

type CadenceOrganization = Pick<
  OrganizationOperationalState,
  'tier' | 'tenant_slug' | 'organization_id' | 'status'
>;

export function managedOrganizationCadenceId(org: Omit<CadenceOrganization, 'status'>): string {
  const scope = [org.tier, org.tenant_slug, org.organization_id];
  return (
    'org-cadence-' + createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 24)
  );
}

export function isManagedOrganizationCadence(charter: DotCharter): boolean {
  const { tier, tenant_slug, organization_id } = charter.scope;
  return Boolean(
    organization_id &&
    !charter.scope.project_id &&
    charter.dot_id === managedOrganizationCadenceId({ tier, tenant_slug, organization_id })
  );
}

export function sameOrganizationCadenceScope(left: DotCharter, right: DotCharter): boolean {
  return (
    left.dot_id !== right.dot_id &&
    left.scope.tier === right.scope.tier &&
    left.scope.tenant_slug === right.scope.tenant_slug &&
    left.scope.organization_id === right.scope.organization_id &&
    left.scope.project_id === right.scope.project_id
  );
}

export function findManualOrganizationCadence(
  managed: DotCharter,
  charters: readonly DotCharter[]
): DotCharter | undefined {
  return charters.find(
    (charter) =>
      charter.operations_cadence &&
      charter.status !== 'retired' &&
      sameOrganizationCadenceScope(charter, managed)
  );
}

/** Default enrollment is deterministic housekeeping. The scoped tick runs approved operations. */
function desiredCadence(org: CadenceOrganization): DotCharter {
  const dotId = managedOrganizationCadenceId(org);
  return {
    kind: 'dot-charter',
    version: '1.0.0',
    dot_id: dotId,
    title: 'Organization operations cadence',
    purpose: 'Tick governed operations in this organization and compile its scheduled reviews.',
    status: 'draft',
    scope: {
      tier: org.tier,
      tenant_slug: org.tenant_slug,
      organization_id: org.organization_id,
    },
    goal: { statement: 'Keep approved organization operations current.' },
    attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *', timezone: 'Asia/Tokyo' }] },
    authority: { authority_role: 'organization_operator', allowed_execution_shapes: [] },
    notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
    operations_cadence: {
      tick_every_minutes: 15,
      standup: { cron: '45 8 * * 1-5', timezone: 'Asia/Tokyo' },
      retro: { cron: '0 17 * * 5', timezone: 'Asia/Tokyo' },
    },
    runtime: { heartbeat_id: 'dot-' + dotId },
  };
}

export function inspectOrganizationCadenceEnrollment(
  org: CadenceOrganization,
  list: () => readonly DotCharter[] = () => listDotCharters().map(({ charter }) => charter)
) {
  if (org.status !== 'active') return { status: 'awaiting_organization' as const };
  const desired = desiredCadence(org);
  const charters = list();
  const manual = findManualOrganizationCadence(desired, charters);
  if (manual) return { status: manual.status, owner: 'manual', dot_id: manual.dot_id };
  if (org.tier !== 'confidential' || !org.tenant_slug)
    return { status: 'not_automatically_managed' as const };
  const generated = charters.find((charter) => charter.dot_id === desired.dot_id);
  if (!generated)
    return {
      status: 'enrollment_required' as const,
      next: 'Apply organization state ensure in the matching scope.',
    };
  if (!organizationCadenceMatchesDefault(generated))
    return { status: 'configuration_drift' as const };
  return { status: generated.status, owner: 'managed', dot_id: generated.dot_id };
}

export function organizationCadenceMatchesDefault(charter: DotCharter): boolean {
  const { tier, tenant_slug, organization_id } = charter.scope;
  return Boolean(
    organization_id &&
    tenant_slug &&
    tier === 'confidential' &&
    isDeepStrictEqual(
      { ...charter, status: 'draft' },
      desiredCadence({ tier, tenant_slug, organization_id, status: 'active' })
    )
  );
}

export function reconcileOrganizationCadence(
  org: CadenceOrganization,
  deps: {
    load?: typeof loadOrganizationOperationalState;
    list?: () => DotCharter[];
    create?: typeof createDraftDotCharter;
    activate?: typeof transitionDotCharterStatus;
    halted?: () => boolean;
  } = {}
): { status: string; dot_id?: string; reason?: string } {
  if (org.tier !== 'confidential' || !org.tenant_slug || org.status !== 'active')
    return { status: 'awaiting_organization' };
  const scope = {
    tier: org.tier,
    tenantSlug: org.tenant_slug,
    organizationId: org.organization_id,
  };
  const stillActive = () =>
    (deps.load ?? loadOrganizationOperationalState)(org.organization_id, scope)?.status ===
    'active';
  const halted = deps.halted ?? (() => getOperationsHaltState().halted);
  try {
    if (halted()) return { status: 'halted' };
    if (!stillActive()) return { status: 'awaiting_organization' };
    const desired = desiredCadence(org);
    const list = deps.list ?? (() => listDotCharters().map(({ charter }) => charter));
    const current = list();
    const id = desired.dot_id;
    const existing = current.find((charter) => charter.dot_id === id);
    const manual = findManualOrganizationCadence(desired, current);
    if (manual) return { status: 'managed_elsewhere', dot_id: manual.dot_id };
    if (existing) {
      if (!isDeepStrictEqual({ ...existing, status: 'draft' }, desired))
        return {
          status: 'needs_attention',
          dot_id: id,
          reason: 'Managed charter differs from the reviewed default.',
        };
      if (existing.status !== 'draft') return { status: existing.status, dot_id: id };
    } else {
      (deps.create ?? createDraftDotCharter)(desired);
    }
    if (halted() || !stillActive()) return { status: 'draft', dot_id: id };
    (deps.activate ?? transitionDotCharterStatus)(id, 'active', {
      expectedScope: desired.scope,
      expectedStatus: 'draft',
    });
    return { status: 'active', dot_id: id };
  } catch (error) {
    return {
      status: 'needs_attention',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const logger = createLogger('organization-cadence-reconcile');
const reported = new Map<string, string>();
let nextSweepAt = 0;

/** Observe configuration drift without granting the resident process lifecycle writes. */
export function sweepOrganizationCadenceEnrollment(now: Date): void {
  if (now.getTime() < nextSweepAt) return;
  nextSweepAt = now.getTime() + 15 * 60_000;
  const visible = listOrganizationScopes({ tier: 'confidential' });
  const seen = new Set<string>();
  let charters: DotCharter[] | undefined;
  const list = () => (charters ??= listDotCharters().map(({ charter }) => charter));
  for (const { tenantSlug, organizationId } of visible) {
    if (!tenantSlug) continue;
    const org = {
      tier: 'confidential' as const,
      tenant_slug: tenantSlug,
      organization_id: organizationId,
      status: 'active' as const,
    };
    const id = managedOrganizationCadenceId(org);
    seen.add(id);
    if (
      loadOrganizationOperationalState(organizationId, {
        tier: org.tier,
        tenantSlug,
      })?.status !== 'active'
    )
      continue;
    const inspected = inspectOrganizationCadenceEnrollment(org, list);
    const finding =
      inspected.status === 'enrollment_required' ||
      inspected.status === 'configuration_drift' ||
      (inspected.status === 'draft' && inspected.owner === 'managed')
        ? inspected.status
        : undefined;
    if (!finding) {
      reported.delete(id);
      continue;
    }
    if (reported.get(id) !== finding) {
      reported.set(id, finding);
      logger.warn(
        `organization cadence enrollment held — scoped setup needs attention | next: inspect organization state ensure and dot validation in the matching scope | evidence: ${id}`
      );
    }
  }
  for (const id of reported.keys()) if (!seen.has(id)) reported.delete(id);
}
