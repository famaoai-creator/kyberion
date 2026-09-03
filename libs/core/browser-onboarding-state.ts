import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';

export interface BrowserOnboardingState {
  version: string;
  status: string;
  applied_at: string;
  identity?: Record<string, unknown>;
  providers?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
  adapter_defaults?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  services?: unknown[];
  voice_profile_id?: string | null;
  tutorial?: Record<string, unknown>;
  artifacts?: string[];
  [key: string]: unknown;
}

const BROWSER_ONBOARDING_STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/browser-onboarding-state.schema.json'
);

/** Load the Browser Onboarding receipt through its persisted-state contract. */
export function loadBrowserOnboardingStateAtPath(filePath: string): BrowserOnboardingState | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return defineCatalog<BrowserOnboardingState>({
      id: 'browser-onboarding-state',
      path: safePath,
      schema: BROWSER_ONBOARDING_STATE_SCHEMA_PATH,
    }).load();
  } catch {
    return null;
  }
}

/** Validate and persist the completion receipt through the same catalog as reads. */
export function writeBrowserOnboardingStateAtPath(
  filePath: string,
  state: BrowserOnboardingState
): string {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = defineCatalog<BrowserOnboardingState>({
    id: 'browser-onboarding-state',
    path: safePath,
    schema: BROWSER_ONBOARDING_STATE_SCHEMA_PATH,
  }).validate(state, safePath);
  safeWriteFile(safePath, JSON.stringify(validated, null, 2), { encoding: 'utf8', mkdir: true });
  return safePath;
}
