import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { readJson } from './foundation/json.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import type { MissionState } from './mission-types.js';

export function getInjectionSignalPath(): string {
  const missionId = (getRegisteredEnvText('MISSION_ID') || 'global').trim();
  if (!missionId || missionId === '.' || missionId === '..' || /[\\/\0]/u.test(missionId)) {
    throw new Error('[INJECTION_SIGNAL_SCOPE] mission id must be a single path segment');
  }
  return assertSafeRepositoryPath(pathResolver.sharedTmp(`injection_suspected_${missionId}.json`), {
    allowMissingLeaf: true,
  });
}

/**
 * Checks whether prompt-injection suspicion is active for the current
 * session/mission context. This low-level signal reader intentionally has no
 * reasoning-backend dependency so policy consumers can fail closed without
 * loading the full untrusted-content scanner.
 */
export function isInjectionSuspected(scope?: string): boolean {
  const injectionSuspected = getRegisteredEnvText('KYBERION_INJECTION_SUSPECTED');
  if (injectionSuspected === '1' || injectionSuspected === 'true') {
    const envScope = getRegisteredEnvText('KYBERION_INJECTION_SCOPE') || 'global';
    if (!scope || envScope === 'global' || envScope === scope) return true;
  }

  const signalPath = getInjectionSignalPath();
  if (safeExistsSync(signalPath)) {
    try {
      const parsed = readJson<{ injection_suspected?: unknown; scopes?: unknown }>(signalPath);
      if (parsed.injection_suspected === true) {
        const scopes = Array.isArray(parsed.scopes) ? parsed.scopes : ['global'];
        if (!scope || scopes.includes('global') || scopes.includes(scope)) return true;
      }
    } catch {
      // A malformed signal is not proof of suspicion; the scanner will still
      // fail closed when it cannot produce a valid verdict.
    }
  }

  const missionId = getRegisteredEnvText('MISSION_ID');
  if (missionId) {
    const tierPath = pathResolver.findMissionPath(missionId);
    if (tierPath) {
      const statePath = path.join(tierPath, 'mission-state.json');
      if (safeExistsSync(statePath)) {
        const state = loadMissionStateAtPath(statePath) as
          | (MissionState & {
              injection_suspected?: unknown;
              injection_scopes?: unknown;
            })
          | null;
        if (state?.injection_suspected === true) {
          const scopes = Array.isArray(state.injection_scopes)
            ? state.injection_scopes
            : ['global'];
          if (!scope || scopes.includes('global') || scopes.includes(scope)) return true;
        }
      }
    }
  }
  return false;
}
