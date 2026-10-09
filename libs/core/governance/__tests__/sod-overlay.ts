import { readJson } from '../../foundation/json.js';
import { pathResolver } from '../../path-resolver.js';
import { safeRmSync, safeWriteFile } from '../../secure-io.js';
import { sodOverlay } from './sod-overlay-state.js';

/**
 * Test support: see sod-overlay-state.ts for the matching customer-resolver
 * mock. The overlay file lives in a per-test location the test file chooses
 * (its own temp root), registered once with {@link useSeparationOfDutiesOverlay}.
 */
let overlayFile: string | null = null;

export function useSeparationOfDutiesOverlay(file: string): void {
  overlayFile = file;
}

function overlayPath(): string {
  if (!overlayFile) {
    throw new Error('call useSeparationOfDutiesOverlay(<per-test temp file>) first');
  }
  return overlayFile;
}

export function setSeparationOfDuties(enabled: boolean): void {
  const product = readJson<Record<string, unknown>>(
    pathResolver.knowledge('product/governance/approval-policy.json')
  );
  safeWriteFile(
    overlayPath(),
    JSON.stringify({ ...product, separation_of_duties: { enabled } }, null, 2)
  );
  sodOverlay.path = overlayPath();
}

/** Replace the overlay with unparseable JSON (policy-read failure). */
export function writeBrokenSeparationOfDutiesPolicy(): void {
  safeWriteFile(overlayPath(), '{ not json');
  sodOverlay.path = overlayPath();
}

export function clearSeparationOfDuties(): void {
  sodOverlay.path = null;
  if (overlayFile) safeRmSync(overlayFile, { force: true });
}
