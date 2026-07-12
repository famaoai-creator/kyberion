import type { TierLevel } from './types.js';

const TIER_SENSITIVITY: Record<TierLevel, number> = {
  public: 1,
  confidential: 3,
  personal: 4,
};

export interface ContextSecurityScope {
  tenant_id: string;
  organization_id?: string;
  project_id?: string;
  mission_id: string;
  participant_id?: string;
  read_tiers: TierLevel[];
  write_tier: TierLevel;
  purpose: string;
  external_egress?: 'deny' | 'allow';
  allowed_reasoning_backends?: string[];
}

export interface GovernedContextFragment<T = unknown> {
  fragment_id: string;
  source_ref: string;
  source_tier: TierLevel;
  tenant_id?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
  purpose_tags?: string[];
  content: T;
}

export type ContextFragmentRejectionCode =
  | 'INVALID_SCOPE'
  | 'TIER_NOT_READABLE'
  | 'TENANT_SCOPE_MISMATCH'
  | 'ORGANIZATION_SCOPE_MISMATCH'
  | 'PROJECT_SCOPE_MISMATCH'
  | 'MISSION_SCOPE_MISMATCH'
  | 'PURPOSE_SCOPE_MISMATCH';

export interface ContextFragmentRejection {
  fragment_id: string;
  source_ref: string;
  code: ContextFragmentRejectionCode;
  reason: string;
}

export interface CompiledContextPack<T = unknown> {
  security_scope: ContextSecurityScope;
  fragments: GovernedContextFragment<T>[];
  rejected: ContextFragmentRejection[];
  effective_input_tier: TierLevel;
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateContextSecurityScope(scope: ContextSecurityScope): string[] {
  const errors: string[] = [];
  if (!nonEmpty(scope.tenant_id)) errors.push('tenant_id is required');
  if (!nonEmpty(scope.mission_id)) errors.push('mission_id is required');
  if (!nonEmpty(scope.purpose)) errors.push('purpose is required');
  if (!Array.isArray(scope.read_tiers) || scope.read_tiers.length === 0) {
    errors.push('read_tiers must contain at least one tier');
  }
  if (!scope.read_tiers.includes(scope.write_tier)) {
    errors.push('write_tier must be included in read_tiers');
  }
  return errors;
}

function reject<T>(
  fragment: GovernedContextFragment<T>,
  code: ContextFragmentRejectionCode,
  reason: string
): ContextFragmentRejection {
  return {
    fragment_id: fragment.fragment_id,
    source_ref: fragment.source_ref,
    code,
    reason,
  };
}

export function evaluateContextFragment<T>(
  scope: ContextSecurityScope,
  fragment: GovernedContextFragment<T>
): ContextFragmentRejection | null {
  const scopeErrors = validateContextSecurityScope(scope);
  if (scopeErrors.length > 0) {
    return reject(fragment, 'INVALID_SCOPE', scopeErrors.join('; '));
  }

  if (!scope.read_tiers.includes(fragment.source_tier)) {
    return reject(
      fragment,
      'TIER_NOT_READABLE',
      `Tier ${fragment.source_tier} is not included in the participant read scope`
    );
  }

  if (fragment.source_tier !== 'public') {
    if (!nonEmpty(fragment.tenant_id) || fragment.tenant_id !== scope.tenant_id) {
      return reject(
        fragment,
        'TENANT_SCOPE_MISMATCH',
        'Non-public context requires an explicit matching tenant_id'
      );
    }
  }

  if (nonEmpty(fragment.organization_id) && fragment.organization_id !== scope.organization_id) {
    return reject(
      fragment,
      'ORGANIZATION_SCOPE_MISMATCH',
      'Fragment organization_id does not match the participant scope'
    );
  }

  if (nonEmpty(fragment.project_id) && fragment.project_id !== scope.project_id) {
    return reject(
      fragment,
      'PROJECT_SCOPE_MISMATCH',
      'Fragment project_id does not match the participant scope'
    );
  }

  if (nonEmpty(fragment.mission_id) && fragment.mission_id !== scope.mission_id) {
    return reject(
      fragment,
      'MISSION_SCOPE_MISMATCH',
      'Fragment mission_id does not match the participant scope'
    );
  }

  if (fragment.purpose_tags?.length && !fragment.purpose_tags.includes(scope.purpose)) {
    return reject(
      fragment,
      'PURPOSE_SCOPE_MISMATCH',
      'Fragment purpose_tags do not include the dispatch purpose'
    );
  }

  return null;
}

function mostSensitiveTier(tiers: TierLevel[]): TierLevel {
  return tiers.reduce<TierLevel>(
    (current, tier) => (TIER_SENSITIVITY[tier] > TIER_SENSITIVITY[current] ? tier : current),
    'public'
  );
}

export function compileScopedContextPack<T>(
  scope: ContextSecurityScope,
  candidates: GovernedContextFragment<T>[]
): CompiledContextPack<T> {
  const scopeErrors = validateContextSecurityScope(scope);
  if (scopeErrors.length > 0) {
    throw new Error(`[CONTEXT_SCOPE_INVALID] ${scopeErrors.join('; ')}`);
  }

  const fragments: GovernedContextFragment<T>[] = [];
  const rejected: ContextFragmentRejection[] = [];
  for (const fragment of candidates) {
    const denial = evaluateContextFragment(scope, fragment);
    if (denial) rejected.push(denial);
    else fragments.push(fragment);
  }

  return {
    security_scope: { ...scope, read_tiers: [...scope.read_tiers] },
    fragments,
    rejected,
    effective_input_tier: mostSensitiveTier(fragments.map((fragment) => fragment.source_tier)),
  };
}

export function validateContextOutputTier(
  pack: Pick<CompiledContextPack, 'effective_input_tier'>,
  outputTier: TierLevel
): { allowed: boolean; reason?: string } {
  if (TIER_SENSITIVITY[outputTier] < TIER_SENSITIVITY[pack.effective_input_tier]) {
    return {
      allowed: false,
      reason: `[CONTEXT_TIER_DOWNFLOW] ${pack.effective_input_tier} context cannot be persisted as ${outputTier} without promotion`,
    };
  }
  return { allowed: true };
}

const LOCAL_REASONING_BACKENDS = /^(stub|local|ollama|mlx|apple-intelligence)$/u;

export function validateReasoningEgress(
  scope: ContextSecurityScope,
  backendName: string
): { allowed: boolean; reason?: string } {
  if (!nonEmpty(backendName)) {
    return { allowed: false, reason: '[CONTEXT_EGRESS_UNKNOWN] Reasoning backend is unknown' };
  }
  if (
    scope.allowed_reasoning_backends?.length &&
    !scope.allowed_reasoning_backends.includes(backendName)
  ) {
    return {
      allowed: false,
      reason: `[CONTEXT_EGRESS_DENIED] Backend ${backendName} is outside allowed_reasoning_backends`,
    };
  }
  if (scope.external_egress === 'deny' && !LOCAL_REASONING_BACKENDS.test(backendName)) {
    return {
      allowed: false,
      reason: `[CONTEXT_EGRESS_DENIED] External backend ${backendName} is forbidden by security_scope`,
    };
  }
  return { allowed: true };
}
