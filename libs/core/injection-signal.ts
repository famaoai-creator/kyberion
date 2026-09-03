import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import type { MissionState } from './mission-types.js';

interface InjectionSignal {
  injection_suspected?: boolean;
  scopes?: string[];
  timestamp?: string;
}

const INJECTION_SIGNAL_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/injection-signal.schema.json'
);

function injectionSignalCatalogAtPath(filePath: string) {
  return defineCatalog<InjectionSignal>({
    id: 'injection-signal',
    path: filePath,
    schema: INJECTION_SIGNAL_SCHEMA_PATH,
  });
}

export function getInjectionSignalPath(): string {
  const missionId = (getRegisteredEnvText('MISSION_ID') || 'global').trim();
  if (!missionId || missionId === '.' || missionId === '..' || /[\\/\0]/u.test(missionId)) {
    throw new Error('[INJECTION_SIGNAL_SCOPE] mission id must be a single path segment');
  }
  return assertSafeRepositoryPath(pathResolver.sharedTmp(`injection_suspected_${missionId}.json`), {
    allowMissingLeaf: true,
  });
}

/** Load the scoped injection signal through the governed catalog boundary. */
export function loadInjectionSignalAtPath(filePath: string): InjectionSignal | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return injectionSignalCatalogAtPath(safePath).load();
  } catch {
    return null;
  }
}

/** Validate and persist the scoped signal through the same contract as reads. */
export function writeInjectionSignalAtPath(filePath: string, signal: InjectionSignal): void {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = injectionSignalCatalogAtPath(safePath).validate(signal, safePath);
  safeWriteFile(safePath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: 'utf8',
    mkdir: true,
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
  const parsed = loadInjectionSignalAtPath(signalPath);
  if (parsed?.injection_suspected === true) {
    const scopes = parsed.scopes || ['global'];
    if (!scope || scopes.includes('global') || scopes.includes(scope)) return true;
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
