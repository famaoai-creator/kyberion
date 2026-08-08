import { logger } from './core.js';
import { loadOrganizationProfile } from './organization-profile.js';
import {
  enqueueOrganizationLearningCandidate,
  type OrganizationLearningSourceType,
  type OrganizationTier,
} from './organization-operating-model.js';

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

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'signal'
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
  const tenantSlug = signal.tenantSlug?.trim() || undefined;
  if (tier === 'confidential' && !tenantSlug) {
    logger.warn(
      `[operational-learning] skipped ${signal.signalId}: confidential tenant scope is missing`
    );
    return null;
  }

  const profile = loadOrganizationProfile(options.rootDir);
  const organizationId = signal.organizationId || profile?.organization_id || 'default';
  const now = options.now || new Date();
  const day = now.toISOString().slice(0, 10);
  const scope = tenantSlug || 'shared';
  const learningId = `ops-${day}-${slug(signal.signalId)}-${tier}-${slug(scope)}`;

  try {
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
    });
    return learningId;
  } catch (error) {
    logger.warn(
      `[operational-learning] enqueue failed for ${learningId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
