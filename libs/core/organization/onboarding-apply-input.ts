import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '../secure-io.js';
import type { OnboardingOperations } from './onboarding-state.js';

export interface OnboardingApplyIdentity {
  name: string;
  language: string;
  interaction_style: 'Senior Partner' | 'Concierge' | 'Minimalist';
  primary_domain: string;
  vision: string;
  agent_id: string;
  persona?: 'sovereign' | 'ecosystem_architect' | 'mission_owner' | 'worker' | 'analyst';
}

export interface OnboardingApplyTenant {
  tenant_slug: string;
  display_name: string;
  assigned_role: string;
  purpose?: string;
}

export interface OnboardingApplyTutorial {
  mode: 'simulate' | 'apply' | 'skipped';
  summary?: string;
}

/** Resident-loop operations block accepted by the non-interactive apply path. */
export interface OnboardingApplyOperations {
  /**
   * 'install' records pending — apply never spawns service installers.
   * 'defer' also records pending (still owed); only 'skip' opts out.
   */
  resident_services?: 'install' | 'defer' | 'skip';
  notification?: {
    surface: NonNullable<OnboardingOperations['notification_surface']>;
    target: string;
  };
  /** Declared intake source ids to enable in event-intake-policy.json. */
  intake_enable?: string[];
}

export interface OnboardingApplyInput {
  identity: OnboardingApplyIdentity;
  tenants?: OnboardingApplyTenant[];
  tutorial?: OnboardingApplyTutorial;
  reasoning_backend?: string;
  operations?: OnboardingApplyOperations;
}

const ONBOARDING_APPLY_INPUT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/onboarding-apply-input.schema.json'
);

function onboardingApplyInputCatalogAtPath(filePath: string) {
  return defineCatalog<OnboardingApplyInput>({
    id: 'onboarding-apply-input',
    path: filePath,
    schema: ONBOARDING_APPLY_INPUT_SCHEMA_PATH,
  });
}

/** Validate one onboarding input against the shared input contract. */
export function validateOnboardingApplyInput(
  value: unknown,
  sourcePath = ONBOARDING_APPLY_INPUT_SCHEMA_PATH
): OnboardingApplyInput {
  return onboardingApplyInputCatalogAtPath(sourcePath).validate(value, sourcePath);
}

/** Load onboarding apply input through the repository and regular-file boundary. */
export function loadOnboardingApplyInputAtPath(filePath: string): OnboardingApplyInput {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`[ONBOARDING_APPLY_INPUT_FILE] input must be a regular file: ${filePath}`);
  }
  return onboardingApplyInputCatalogAtPath(safePath).load();
}
