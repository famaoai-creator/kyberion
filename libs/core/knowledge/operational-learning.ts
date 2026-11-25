import { createHash } from 'node:crypto';
import { logger } from '../core.js';
import { formatDiagnostic } from '../logger.js';
import { resolveIdentityContext, withStoreGrant } from '../authority.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { loadOrganizationProfile } from '../organization/organization-profile.js';
import {
  enqueueOrganizationLearningCandidate,
  listOrganizationLearningCandidates,
  type OrganizationLearningCandidate,
  type OrganizationLearningSourceType,
  type OrganizationTier,
  type QueueOrganizationLearningCandidateInput,
} from '../organization/organization-operating-model.js';
import { resolveScopeResolution } from '../scope-context.js';
import { sendOpsAlert } from '../daemon/ops-alert.js';
import { NHI_IDENTITY_ENV } from '../organization/nhi-session-admission.js';

/**
 * One configuration alert per day while personal-tier signals have no owner:
 * the gap is a property of the process (no claimed NHI), not of each signal,
 * so a per-learning-id alert only repeated the same finding several times a day.
 */
const PERSONAL_OWNER_MISSING_ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Process-local guard so a long-lived daemon does not even append suppressed rows. */
let personalOwnerMissingAlertedAt: number | undefined;

/** Test seam: forget the process-local alert guard. */
export function resetOperationalLearningAlertStateForTests(): void {
  personalOwnerMissingAlertedAt = undefined;
}

export interface OperationalLearningSignal {
  signalId: string;
  sourceType: OrganizationLearningSourceType;
  sourceRef: string;
  title: string;
  summary: string;
  evidenceRefs?: string[];
  targetKind?: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';
  organizationId?: string;
  tier?: OrganizationTier;
  tenantSlug?: string;
  metadata?: Record<string, unknown>;
}

/** Strip leading/trailing '-' without a regex (an anchored `-+$` backtracks polynomially). */
function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

function slug(value: string): string {
  return (
    trimDashes(
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
    ) || 'signal'
  );
}

interface LearningScope {
  tier: OrganizationTier;
  tenantSlug?: string;
  organizationId: string;
  /** Personal tier only: the owner the candidate is captured for (never inferred). */
  ownerNhi?: string;
}

/**
 * A personal-tier learning needs an explicit owner (D8). The owner is the NHI
 * the producer resolved for the signal (`KYBERION_NHI_ID`, or the claimed NHI
 * via scope resolution) and is never invented. Without one the signal is
 * skipped and the gap surfaces as a single daily configuration alert instead
 * of a dropped-candidate alert per signal.
 */
function resolvePersonalOwner(signalId: string, producerNhi: string | undefined): string | null {
  const owner = producerNhi?.trim() || undefined;
  if (owner) return owner;
  logger.debug(
    `[operational-learning] skipped ${signalId}: personal tier has no owner (${NHI_IDENTITY_ENV} unset)`
  );
  const now = Date.now();
  if (
    personalOwnerMissingAlertedAt !== undefined &&
    now - personalOwnerMissingAlertedAt < PERSONAL_OWNER_MISSING_ALERT_INTERVAL_MS
  )
    return null;
  personalOwnerMissingAlertedAt = now;
  try {
    sendOpsAlert(
      {
        severity: 'warning',
        title: 'Operational learning paused: personal tier has no owner',
        context: { tier: 'personal', missing: NHI_IDENTITY_ENV },
        recommendation: `Operational learning signals for the personal organization are skipped because this process claims no owner NHI. Set ${NHI_IDENTITY_ENV} to the installation owner's NHI in the daemon's service environment (an identity decision for the owner), then restart the daemon; until then no personal candidates are queued.`,
        dedupe_key: 'operational-learning:personal-owner-missing',
        category: 'learning',
      },
      { minIntervalMs: PERSONAL_OWNER_MISSING_ALERT_INTERVAL_MS }
    );
  } catch {
    // observability only
  }
  return null;
}

/**
 * The organization / tier / tenant a machine-generated candidate lands in:
 * always the caller's active scope. A requested tenant or organization that
 * differs from it is refused (null, with a warning), never honoured.
 */
function resolveLearningScope(
  signal: Pick<OperationalLearningSignal, 'signalId' | 'tier' | 'tenantSlug' | 'organizationId'>,
  options: { rootDir?: string }
): LearningScope | null {
  const tier = signal.tier || 'personal';
  const profile = loadOrganizationProfile(options.rootDir);
  const resolvedScope = resolveScopeResolution().scope;
  const activeTenantSlug = resolveIdentityContext().tenantSlug?.trim() || undefined;
  const activeOrganizationId =
    currentExecutionScope()?.organizationId ||
    resolvedScope.organization_id ||
    profile?.organization_id ||
    'default';
  const requestedTenantSlug = signal.tenantSlug?.trim() || undefined;
  const requestedOrganizationId = signal.organizationId?.trim() || undefined;

  if (requestedTenantSlug && requestedTenantSlug !== activeTenantSlug) {
    logger.warn(
      formatDiagnostic({
        component: 'operational-learning',
        what: `skipped ${signal.signalId}`,
        why: `requested tenant '${requestedTenantSlug}' does not match the active tenant scope`,
      })
    );
    return null;
  }
  if (requestedOrganizationId && requestedOrganizationId !== activeOrganizationId) {
    logger.warn(
      formatDiagnostic({
        component: 'operational-learning',
        what: `skipped ${signal.signalId}`,
        why: `requested organization '${requestedOrganizationId}' does not match the active organization scope`,
      })
    );
    return null;
  }

  const tenantSlug = activeTenantSlug;
  if (tier === 'confidential' && !tenantSlug) {
    logger.warn(
      `[operational-learning] skipped ${signal.signalId}: confidential tenant scope is missing`
    );
    return null;
  }
  if (tier === 'personal') {
    const ownerNhi = resolvePersonalOwner(signal.signalId, resolvedScope.nhi_id);
    if (!ownerNhi) return null;
    return {
      tier,
      ...(tenantSlug ? { tenantSlug } : {}),
      organizationId: activeOrganizationId,
      ownerNhi,
    };
  }
  return { tier, ...(tenantSlug ? { tenantSlug } : {}), organizationId: activeOrganizationId };
}

function candidateInput(
  signal: OperationalLearningSignal,
  learningId: string,
  scope: LearningScope
): QueueOrganizationLearningCandidateInput {
  return {
    learningId,
    organizationId: scope.organizationId,
    sourceType: signal.sourceType,
    sourceRef: signal.sourceRef,
    title: signal.title,
    summary: signal.summary,
    evidenceRefs: signal.evidenceRefs || [],
    targetKind: signal.targetKind || 'sop_candidate',
    tier: scope.tier,
    ...(scope.tenantSlug ? { tenantSlug: scope.tenantSlug } : {}),
    ...(scope.ownerNhi ? { ownerNhi: scope.ownerNhi } : {}),
    ...(signal.metadata ? { metadata: signal.metadata } : {}),
  };
}

/**
 * LC-16: turn a deterministic operational finding into a governed learning
 * candidate. The candidate is proposed only; a human or mission still owns
 * approval and promotion.
 */
export function enqueueOperationalLearningSignal(
  signal: OperationalLearningSignal,
  options: { now?: Date; rootDir?: string } = {}
): string | null {
  const scope = resolveLearningScope(signal, options);
  if (!scope) return null;
  const now = options.now || new Date();
  const day = now.toISOString().slice(0, 10);
  const learningId = `ops-${day}-${slug(signal.signalId)}-${scope.tier}-${slug(scope.tenantSlug || 'shared')}`;

  try {
    withStoreGrant(
      'operational_learning_writer',
      () =>
        enqueueOrganizationLearningCandidate({
          ...candidateInput(signal, learningId, scope),
          ...(options.rootDir ? { rootDir: options.rootDir } : {}),
        }),
      { tenantSlug: scope.tenantSlug, organizationId: scope.organizationId }
    );
    return learningId;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      formatDiagnostic({
        component: 'operational-learning',
        what: `enqueue failed for ${learningId}`,
        why: reason,
      })
    );
    // A dropped candidate is silent attrition in the improvement loop — the
    // warn above is only in process logs. Surface it once per learning id so
    // a scope/config defect (e.g. a personal organization missing owner
    // binding) becomes actionable instead of recurring invisibly. Detail
    // (title, reason) stays out of the record for non-public scopes — the
    // ops-alert log is watched by lower-clearance readers.
    const isPublic = scope.tier === 'public' && !scope.tenantSlug;
    try {
      sendOpsAlert({
        severity: 'warning',
        title: isPublic
          ? `Learning candidate dropped: ${signal.title.slice(0, 120)}`
          : 'Learning candidate dropped (scoped signal)',
        context: {
          signal_id: signal.signalId,
          learning_id: learningId,
          tier: scope.tier,
          ...(isPublic ? { tenant: scope.tenantSlug ?? 'shared', reason } : {}),
        },
        recommendation:
          'An operational learning signal could not be queued as a candidate — check the target organization learning store scope (owner binding for personal organizations, tenant binding for confidential ones).',
        dedupe_key: `operational-learning-enqueue:${learningId}`,
        category: 'learning',
      });
    } catch {
      // observability only — the enqueue failure itself is already logged
    }
    return null;
  }
}

export interface OperationalLearningCandidateOnceResult {
  /** The candidate queued now, or the earlier candidate that stands. */
  learning_id: string;
  /** false when an earlier candidate stands (left untouched, whatever its status). */
  created: boolean;
}

/**
 * Queue a candidate exactly once per dedupe key: an earlier candidate of the
 * organization with the same id, or with the same `metadata.dedupe_key`
 * (proposed, approved, rejected or promoted), stands and is never overwritten
 * — unless `supersedes(latest)` says the new evidence materially changed. The
 * check and the write run under one inter-process lock per tier × tenant ×
 * dedupe key (taken under the caller's identity, outside the writer role), so
 * concurrent runs cannot both queue it. The writer role reads only its own
 * organization's learning store, so a caller that may target several
 * organizations of one tenant keeps its own tenant-level record of what it
 * queued (CD-12: the tenant learning reports) and asks only for new ones. Same scope rules and the
 * same narrow writer role as {@link enqueueOperationalLearningSignal}; throws
 * on a write failure (the caller reports it). Null when the scope refuses the
 * signal.
 */
export function enqueueOperationalLearningCandidateOnce(
  signal: OperationalLearningSignal & { learningId: string; dedupeKey?: string },
  options: {
    rootDir?: string;
    supersedes?: (latest: OrganizationLearningCandidate) => boolean;
  } = {}
): OperationalLearningCandidateOnceResult | null {
  const scope = resolveLearningScope(signal, options);
  if (!scope) return null;
  const dedupeKey = signal.dedupeKey ?? signal.learningId;
  const lockId = `operational-learning-${scope.tier}-${scope.tenantSlug || 'shared'}-${createHash(
    'sha256'
  )
    .update(dedupeKey)
    .digest('hex')
    .slice(0, 24)}`;
  return withLockSync(lockId, () =>
    withStoreGrant(
      'operational_learning_writer',
      () => {
        const matches = listOrganizationLearningCandidates({
          organizationId: scope.organizationId,
          tier: scope.tier,
          tenantSlug: scope.tenantSlug || 'shared',
          ...(options.rootDir ? { rootDir: options.rootDir } : {}),
        }).filter(
          (candidate) =>
            (candidate.tenant_slug ?? undefined) === scope.tenantSlug &&
            (candidate.learning_id === signal.learningId ||
              candidate.metadata?.dedupe_key === dedupeKey)
        );
        const same = matches.find((candidate) => candidate.learning_id === signal.learningId);
        if (same) return { learning_id: same.learning_id, created: false };
        const latest = [...matches].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
        if (latest && !(options.supersedes?.(latest) ?? false))
          return { learning_id: latest.learning_id, created: false };
        enqueueOrganizationLearningCandidate({
          ...candidateInput(
            { ...signal, metadata: { ...(signal.metadata ?? {}), dedupe_key: dedupeKey } },
            signal.learningId,
            scope
          ),
          ...(options.rootDir ? { rootDir: options.rootDir } : {}),
        });
        return { learning_id: signal.learningId, created: true };
      },
      { tenantSlug: scope.tenantSlug, organizationId: scope.organizationId }
    )
  );
}
