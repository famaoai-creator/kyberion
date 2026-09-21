/**
 * Mission provider pins — storage only.
 *
 * Pins freeze provider choices for a mission so replays reproduce them:
 * model pins (`pins`, owned by capability-broker.ts) and seam provider pins
 * (`seam_pins`, owned by seam-provider-selection.ts). Kept free of provider
 * discovery so seams can pin without importing the broker (which would close
 * an import cycle through the providers it discovers).
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import type { HealthAwareResolution } from './provider-health-registry.js';

export interface PinnedEntry {
  provider: string;
  modelId: string;
  instance: string | null;
  orchestration: HealthAwareResolution['orchestration'];
  pinnedAt: string;
  by: string;
}

/** A seam provider choice frozen for the mission (see seam-provider-selection.ts). */
export interface SeamPinnedEntry {
  seam: string;
  provider_id: string;
  purpose?: string;
  pinnedAt: string;
  by: string;
}

export interface PinFile {
  version: string;
  missionId?: string;
  pins: Record<string, PinnedEntry>;
  seam_pins?: Record<string, SeamPinnedEntry>;
}

export const PIN_FILE_VERSION = '1.0';
const PROVIDER_PINS_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/provider-pins.schema.json'
);

export function pinActorId(): string {
  return (
    getRegisteredEnvText('KYBERION_PERSONA') ||
    getRegisteredEnvText('MISSION_ROLE') ||
    'capability-broker'
  );
}

/**
 * Where pins live. Inside the mission's own repo when MISSION_ID resolves to one (so they roll back
 * atomically with the mission); otherwise a shared runtime file keyed by mission id.
 */
function pinFilePath(): string {
  const missionId = getRegisteredEnvText('MISSION_ID');
  if (missionId) {
    for (const tier of ['personal', 'confidential', 'public']) {
      const missionDir = pathResolver.rootResolve(path.join('active/missions', tier, missionId));
      const missionStatePath = assertSafeRepositoryPath(
        path.join(missionDir, 'mission-state.json'),
        { allowMissingLeaf: true }
      );
      if (safeExistsSync(missionStatePath)) {
        return assertSafeRepositoryPath(path.join(missionDir, 'provider-pins.json'), {
          allowMissingLeaf: true,
        });
      }
    }
    return assertSafeRepositoryPath(
      pathResolver.rootResolve(
        path.join('active/shared/runtime/provider-pins', `${missionId}.json`)
      ),
      { allowMissingLeaf: true }
    );
  }
  return assertSafeRepositoryPath(
    pathResolver.rootResolve('active/shared/runtime/provider-pins/default.json'),
    { allowMissingLeaf: true }
  );
}

const providerPinsCatalog = defineCatalog<PinFile>({
  id: 'provider-pins',
  path: pinFilePath,
  schema: PROVIDER_PINS_SCHEMA_PATH,
});

export function readPinFile(): PinFile {
  try {
    const filePath = pinFilePath();
    if (!safeLstat(filePath).isFile()) return { version: PIN_FILE_VERSION, pins: {} };
    return providerPinsCatalog.load();
  } catch {
    /* treat as empty */
  }
  return { version: PIN_FILE_VERSION, pins: {} };
}

export function writePinFile(file: PinFile): void {
  const filePath = pinFilePath();
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(file, null, 2), { encoding: 'utf8' });
}

function seamPinKey(seam: string, decisionKey: string): string {
  return `${seam}:${decisionKey}`;
}

export function loadSeamProviderPin(seam: string, decisionKey: string): SeamPinnedEntry | null {
  return readPinFile().seam_pins?.[seamPinKey(seam, decisionKey)] ?? null;
}

export function pinSeamProviderDecision(
  seam: string,
  decisionKey: string,
  providerId: string,
  purpose?: string
): SeamPinnedEntry {
  const file = readPinFile();
  const entry: SeamPinnedEntry = {
    seam,
    provider_id: providerId,
    ...(purpose ? { purpose } : {}),
    pinnedAt: nowIso(),
    by: pinActorId(),
  };
  file.version = PIN_FILE_VERSION;
  file.missionId = getRegisteredEnvText('MISSION_ID');
  file.seam_pins = { ...(file.seam_pins ?? {}), [seamPinKey(seam, decisionKey)]: entry };
  writePinFile(file);
  return entry;
}

export function unpinSeamProviderDecision(seam: string, decisionKey: string): void {
  const file = readPinFile();
  const key = seamPinKey(seam, decisionKey);
  if (file.seam_pins?.[key]) {
    delete file.seam_pins[key];
    writePinFile(file);
  }
}
