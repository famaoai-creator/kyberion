/**
 * `pnpm doctor` VCS host section (VCS host API seam design).
 *
 * Default: offline. Explains which vcs-host provider the default chain would
 * pick and why, using the same chain and `isAvailable()` checks as real forge
 * operations (gh-cli runs `gh --version` locally; github-rest only checks for
 * a registered token). Never counts as missing: forge access is not a runtime
 * readiness condition.
 *
 * `--vcs-auth`: additionally runs `vcsHostAuthStatus()` on the selected
 * provider (one network call, bounded by a timeout). Output is sanitized by
 * the verb layer.
 */
import {
  inspectVcsHostSelection,
  type VcsHostSelection,
  type VcsHostSelectionCandidate,
} from '@agent/core/vcs/vcs-host';
import { vcsHostAuthStatus } from '@agent/core/vcs/vcs-host-verbs';

export const VCS_AUTH_TIMEOUT_MS = 10_000;

type AuthResult = { provider: string; ok: boolean; detail?: string };

export interface VcsHostDoctorDeps {
  inspect?: () => VcsHostSelection;
  authStatus?: (provider: string, timeoutMs: number) => Promise<AuthResult>;
  timeoutMs?: number;
}

function describeCandidate(candidate: VcsHostSelectionCandidate): string {
  if (!candidate.registered) return `${candidate.id}=not registered`;
  if (candidate.id === 'github-rest')
    return `${candidate.id}=${candidate.available ? 'GH_TOKEN registered' : 'no GH_TOKEN'}`;
  if (candidate.id === 'gh-cli')
    return `${candidate.id}=${candidate.available ? 'available' : 'gh not found'}`;
  return `${candidate.id}=${candidate.available ? 'available' : 'unavailable'}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const defaultAuthStatus = (provider: string, timeoutMs: number) =>
  vcsHostAuthStatus({ provider, timeoutMs });

export async function collectVcsHostDoctorLines(
  options: { probeAuth?: boolean } = {},
  deps: VcsHostDoctorDeps = {}
): Promise<string[]> {
  let selection: VcsHostSelection;
  try {
    selection = (deps.inspect ?? inspectVcsHostSelection)();
  } catch (error) {
    return [
      `VCS host: inspection unavailable (${error instanceof Error ? error.message : String(error)})`,
    ];
  }
  const order = `order: ${selection.chain.join(' → ') || '(empty)'}, source: ${selection.source}`;
  const candidates = selection.candidates.map(describeCandidate).join(', ');
  if (!selection.selected) {
    return [
      `VCS host: none available (${order}); ${candidates} — install gh or register GH_TOKEN (PR operations will fail)`,
    ];
  }
  const head = `VCS host: ${selection.selected} (${order}); ${candidates}`;
  if (!options.probeAuth) return [`${head}; auth not probed (pass --vcs-auth)`];
  const timeoutMs = deps.timeoutMs ?? VCS_AUTH_TIMEOUT_MS;
  try {
    const auth = await withTimeout(
      (deps.authStatus ?? defaultAuthStatus)(selection.selected, timeoutMs),
      timeoutMs
    );
    return [`${head}; auth ${auth.ok ? 'ok' : `failed${auth.detail ? ` (${auth.detail})` : ''}`}`];
  } catch (error) {
    return [
      `${head}; auth probe failed (${error instanceof Error ? error.message : String(error)})`,
    ];
  }
}
