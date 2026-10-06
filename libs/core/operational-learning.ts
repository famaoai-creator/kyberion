import { logger } from './core.js';
import { formatDiagnostic } from './logger.js';
import { resolveIdentityContext, withExecutionContext } from './authority.js';
import { currentExecutionScope } from './foundation/execution-scope.js';
import { loadOrganizationProfile } from './organization/organization-profile.js';
import {
  enqueueOrganizationLearningCandidate,
  type OrganizationLearningSourceType,
  type OrganizationTier,
} from './organization/organization-operating-model.js';
import { resolveScopeResolution } from './scope-context.js';

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

/**
 * LC-16: turn a deterministic operational finding into a governed learning
 * candidate. The candidate is proposed only; a human or mission still owns
 * approval and promotion.
 */
export function enqueueOperationalLearningSignal(
  signal: OperationalLearningSignal,
  options: { now?: Date; rootDir?: string } = {}
): string | null {
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

  const organizationId = activeOrganizationId;
  const now = options.now || new Date();
  const day = now.toISOString().slice(0, 10);
  const scope = tenantSlug || 'shared';
  const learningId = `ops-${day}-${slug(signal.signalId)}-${tier}-${slug(scope)}`;

  try {
    withExecutionContext(
      'operational_learning_writer',
      () =>
        enqueueOrganizationLearningCandidate({
          learningId,
          organizationId,
          sourceType: signal.sourceType,
          sourceRef: signal.sourceRef,
          title: signal.title,
          summary: signal.summary,
          evidenceRefs: signal.evidenceRefs || [],
          targetKind: signal.targetKind || 'sop_candidate',
          tier,
          ...(tenantSlug ? { tenantSlug } : {}),
          ...(signal.metadata ? { metadata: signal.metadata } : {}),
        }),
      undefined,
      tenantSlug,
      organizationId
    );
    return learningId;
  } catch (error) {
    logger.warn(
      formatDiagnostic({
        component: 'operational-learning',
        what: `enqueue failed for ${learningId}`,
        why: error instanceof Error ? error.message : String(error),
      })
    );
    return null;
  }
}
