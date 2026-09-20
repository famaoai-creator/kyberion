import { nowIso } from './foundation/time.js';
import { readJson } from './foundation/json.js';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';
import {
  BACKEND_CAPABILITY_PROFILES,
  type BackendUtilityFit,
} from './backend-capability-profile.js';
import { providerIdForReasoningIdentifier } from './provider-egress-gate.js';
import { loadModelRoleFitnessRecords, normalizeFitnessProviderId } from './model-role-fitness.js';

/**
 * TC-17: is what we DECLARE about a backend what we have MEASURED?
 *
 * `BACKEND_CAPABILITY_PROFILES` is the table routing consults to decide what
 * a backend can be asked to do. Its `utility_fit` field is the strongest
 * claim in it — "this backend can judge" decides whether a model is trusted
 * to review work — and it is produced by a default argument: every CLI and
 * API backend is declared `judge, classify, summarize, divergent` unless
 * someone overrode it by hand. Nothing has ever checked that claim against a
 * measurement, and until TC-15 there was no measurement to check it against.
 *
 * This is the same reconciliation TC-11 performs for roles and the pool,
 * applied to backends: a claim contradicted by evidence fails; a claim with
 * no evidence is reported, because "unproven" is a fact worth seeing and not
 * a defect worth blocking on.
 */
export type CapabilityClaimVerdict = 'confirmed' | 'contradicted' | 'unproven' | 'unmeasurable';

export interface UtilityFitClaim {
  mode: string;
  provider?: string;
  fit: BackendUtilityFit;
  verdict: CapabilityClaimVerdict;
  /** Team role whose probe evidences this claim, when one exists. */
  evidence_role?: string;
  evidence_models: string[];
  detail?: string;
}

export type BackendHonestyViolationKind =
  'policy_mode_without_profile' | 'contradicted_utility_fit';

export interface BackendHonestyViolation {
  kind: BackendHonestyViolationKind;
  mode: string;
  detail: string;
}

export interface BackendCapabilityHonestyReport {
  generated_at: string;
  /** Modes the governed policy allows. */
  policy_modes: string[];
  /** Declared profiles with no mode in the governed policy — dead declarations. */
  unreachable_profiles: string[];
  claims: UtilityFitClaim[];
  /** Claims asserting judgement ability with nothing measured behind them. */
  unproven_claim_count: number;
  violations: BackendHonestyViolation[];
}

/**
 * Which role probe evidences which declared utility.
 *
 * Only `judge` is measurable today: `reviewer` is the role whose probe asks a
 * model to judge work and be right about it. The other three stay
 * `unmeasurable` until a probe exists for them — naming that gap is the point
 * rather than inventing a proxy for it.
 */
const UTILITY_FIT_EVIDENCE_ROLE: Partial<Record<BackendUtilityFit, string>> = {
  judge: 'reviewer',
};

function loadPolicyModes(): string[] {
  const policyPath = pathResolver.knowledge('product/governance/reasoning-backend-policy.json');
  if (!safeExistsSync(policyPath)) return [];
  const policy = readJson<{ allowed_modes?: string[] }>(policyPath);
  return Array.isArray(policy.allowed_modes) ? [...policy.allowed_modes] : [];
}

export function buildBackendCapabilityHonestyReport(): BackendCapabilityHonestyReport {
  const policyModes = loadPolicyModes();
  const policyModeSet = new Set(policyModes);
  const declaredModes = Object.keys(BACKEND_CAPABILITY_PROFILES);

  const fitnessByProviderRole = new Map<string, { passed: string[]; failed: string[] }>();
  for (const record of loadModelRoleFitnessRecords()) {
    const provider = normalizeFitnessProviderId(
      record.provider?.trim() || providerIdForReasoningIdentifier(record.backend) || record.backend
    );
    if (!provider) continue;
    const key = `${provider}::${record.team_role}`;
    const bucket = fitnessByProviderRole.get(key) || { passed: [], failed: [] };
    const target = record.passed ? bucket.passed : bucket.failed;
    // A model probed several times is one piece of evidence, not several.
    if (!target.includes(record.model_id)) target.push(record.model_id);
    fitnessByProviderRole.set(key, bucket);
  }

  const claims: UtilityFitClaim[] = [];
  const violations: BackendHonestyViolation[] = [];

  for (const mode of declaredModes.sort()) {
    const profile = BACKEND_CAPABILITY_PROFILES[mode as keyof typeof BACKEND_CAPABILITY_PROFILES];
    const provider = normalizeFitnessProviderId(providerIdForReasoningIdentifier(mode) || mode);
    for (const fit of profile.utility_fit) {
      const evidenceRole = UTILITY_FIT_EVIDENCE_ROLE[fit];
      if (!evidenceRole) {
        claims.push({
          mode,
          ...(provider ? { provider } : {}),
          fit,
          verdict: 'unmeasurable',
          evidence_models: [],
        });
        continue;
      }
      if (!provider) {
        claims.push({
          mode,
          fit,
          verdict: 'unmeasurable',
          evidence_role: evidenceRole,
          evidence_models: [],
          detail: 'no provider id maps to this mode, so no measurement can be attributed to it',
        });
        continue;
      }
      const bucket = fitnessByProviderRole.get(`${provider}::${evidenceRole}`);
      if (!bucket || (bucket.passed.length === 0 && bucket.failed.length === 0)) {
        claims.push({
          mode,
          provider,
          fit,
          verdict: 'unproven',
          evidence_role: evidenceRole,
          evidence_models: [],
        });
        continue;
      }
      if (bucket.failed.length > 0) {
        claims.push({
          mode,
          provider,
          fit,
          verdict: 'contradicted',
          evidence_role: evidenceRole,
          evidence_models: bucket.failed,
          detail: `${bucket.failed.join(', ')} failed the ${evidenceRole} probe`,
        });
        violations.push({
          kind: 'contradicted_utility_fit',
          mode,
          detail: `${mode} is declared '${fit}'-capable, but ${bucket.failed.join(', ')} failed the ${evidenceRole} fitness probe.`,
        });
        continue;
      }
      claims.push({
        mode,
        provider,
        fit,
        verdict: 'confirmed',
        evidence_role: evidenceRole,
        evidence_models: bucket.passed,
      });
    }
  }

  for (const mode of policyModes) {
    if (!declaredModes.includes(mode)) {
      violations.push({
        kind: 'policy_mode_without_profile',
        mode,
        detail: `The governed reasoning-backend policy allows '${mode}', but no capability profile declares what it can do, so routing has nothing to consult.`,
      });
    }
  }

  return {
    generated_at: nowIso(),
    policy_modes: policyModes,
    unreachable_profiles: declaredModes.filter((mode) => !policyModeSet.has(mode)).sort(),
    claims,
    unproven_claim_count: claims.filter((claim) => claim.verdict === 'unproven').length,
    violations,
  };
}

export function formatBackendCapabilityHonestyReport(
  report: BackendCapabilityHonestyReport
): string {
  const lines: string[] = [];
  const byVerdict = (verdict: CapabilityClaimVerdict) =>
    report.claims.filter((claim) => claim.verdict === verdict);

  lines.push('declared backend utility claims');
  lines.push(
    `  confirmed=${byVerdict('confirmed').length} contradicted=${byVerdict('contradicted').length} ` +
      `unproven=${byVerdict('unproven').length} unmeasurable=${byVerdict('unmeasurable').length}`
  );
  for (const claim of report.claims) {
    if (claim.verdict === 'unmeasurable') continue;
    lines.push(
      `  ${claim.mode.padEnd(16)} ${claim.fit.padEnd(10)} ${claim.verdict.padEnd(13)}` +
        (claim.evidence_models.length > 0 ? ` via ${claim.evidence_models.join(', ')}` : '') +
        (claim.detail ? `  (${claim.detail})` : '')
    );
  }
  if (report.unreachable_profiles.length > 0) {
    lines.push('');
    lines.push(
      `profiles for modes the governed policy does not allow: ${report.unreachable_profiles.join(', ')}`
    );
  }
  lines.push('');
  if (report.violations.length === 0) {
    lines.push('violations: none');
  } else {
    lines.push(`violations: ${report.violations.length}`);
    for (const violation of report.violations) {
      lines.push(`  [${violation.kind}] ${violation.mode}: ${violation.detail}`);
    }
  }
  return lines.join('\n');
}
