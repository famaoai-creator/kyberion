import { compileSchema } from './foundation/ajv.js';
import { parseSafeJsonObjectValue, readJson } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

export type OnboardingPhase =
  'identity' | 'reasoning' | 'services' | 'tenants' | 'tutorial' | 'summary';
export type OnboardingStatus = 'draft' | 'complete';
export type OnboardingServiceStatus = 'pending' | 'saved' | 'ready' | 'blocked' | 'skipped';

export interface OnboardingIdentity {
  name: string;
  language: string;
  interaction_style: 'Senior Partner' | 'Concierge' | 'Minimalist';
  primary_domain: string;
  vision: string;
  agent_id: string;
  persona: 'sovereign' | 'ecosystem_architect' | 'mission_owner' | 'worker' | 'analyst';
}

export interface OnboardingServiceCandidate {
  service_id: string;
  status: OnboardingServiceStatus;
  connection_kind?: 'base_url' | 'output_dir' | 'cli_path' | 'custom' | 'none';
  base_url?: string;
  output_dir?: string;
  cli_path?: string;
  notes?: string;
  captured_at: string;
}

export interface OnboardingTenant {
  tenant_slug: string;
  tenant_id?: string;
  display_name: string;
  status: 'active' | 'suspended' | 'archived';
  assigned_role: string;
  purpose?: string;
  created_at: string;
}

export interface OnboardingTutorial {
  mode: 'simulate' | 'apply' | 'skipped';
  summary?: string;
  plan_path?: string;
}

export interface OnboardingReasoningSnapshot {
  mode: 'real_backend_detected' | 'stub_explicit' | 'stub_acknowledged' | 'missing';
  backend_hint: string;
  available: boolean;
  reason?: string;
  checked_at: string;
}

export interface OnboardingProfileState {
  version: '1.0.0';
  status: OnboardingStatus;
  current_phase: OnboardingPhase;
  completed_phases: OnboardingPhase[];
  created_at: string;
  updated_at: string;
  identity?: OnboardingIdentity;
  reasoning?: OnboardingReasoningSnapshot;
  services?: { candidates: OnboardingServiceCandidate[] };
  tenants?: { entries: OnboardingTenant[] };
  tutorial?: OnboardingTutorial;
}

const onboardingStateValidate = compileSchema<OnboardingProfileState>(
  pathResolver.knowledge('product/schemas/onboarding-state.schema.json')
);

/** Parse a persisted onboarding state, including the legacy persona default. */
export function parseOnboardingState(value: unknown): OnboardingProfileState {
  const root = parseSafeJsonObjectValue(value, 'onboarding state');
  const identity = root.identity;
  const normalized =
    identity && typeof identity === 'object' && !Array.isArray(identity)
      ? {
          ...root,
          identity: {
            ...(identity as Record<string, unknown>),
            ...('persona' in identity ? {} : { persona: 'sovereign' }),
          },
        }
      : root;
  const candidate = Object.fromEntries(
    Object.entries(normalized).filter(([key]) => key !== '$schema')
  );
  if (onboardingStateValidate(candidate)) return candidate as OnboardingProfileState;
  const errors = (onboardingStateValidate.errors || [])
    .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
    .join('; ');
  throw new Error(`Invalid onboarding state: ${errors}`);
}

/** Load onboarding state from an already resolved repository path. */
export function loadOnboardingStateAtPath(filePath: string): OnboardingProfileState | null {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
  return parseOnboardingState(readJson<unknown>(safePath));
}
