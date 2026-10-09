import { readJson } from '../../foundation/json.js';
import { pathResolver } from '../../path-resolver.js';
import { safeRmSync, safeWriteFile } from '../../secure-io.js';
import { sodOverlay } from './sod-overlay-state.js';

/** Test support: see sod-overlay-state.ts for the matching customer-resolver mock. */
const overlayPath = () => pathResolver.sharedTmp(`approval-sod-overlay-${process.pid}.json`);

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

export function clearSeparationOfDuties(): void {
  sodOverlay.path = null;
  safeRmSync(overlayPath(), { force: true });
}
