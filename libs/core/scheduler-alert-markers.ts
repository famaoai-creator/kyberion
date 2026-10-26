/** Governed durable deduplication markers for scheduler operational alerts. */
import { defineCatalog } from './foundation/governed-catalog.js';
import { withOperationalAlertStore } from './foundation/operational-store-policy.js';
import { writeJson } from './foundation/json.js';
import { knowledge, shared } from './path-resolver.js';
import { safeExistsSync, safeLstat } from './secure-io.js';

export type SchedulerOpsAlertDays = Record<string, string>;
const MARKER_PATH = 'runtime/state/scheduler-ops-alert-days.json';
function catalog(filePath: string) {
  return defineCatalog<SchedulerOpsAlertDays>({
    id: 'scheduler-ops-alert-days',
    path: filePath,
    schema: knowledge('product/schemas/scheduler-ops-alert-days.schema.json'),
  });
}
export function readSchedulerOpsAlertDays(): SchedulerOpsAlertDays | null {
  return withOperationalAlertStore(() => {
    const markerPath = shared(MARKER_PATH);
    if (!safeExistsSync(markerPath)) return null;
    try {
      return safeLstat(markerPath).isFile() ? catalog(markerPath).load() : null;
    } catch {
      return null;
    }
  });
}
export function writeSchedulerOpsAlertDay(key: string, now = new Date()): void {
  withOperationalAlertStore(() => {
    const markerPath = shared(MARKER_PATH);
    const marker = catalog(markerPath).validate(
      { ...(readSchedulerOpsAlertDays() ?? {}), [key]: now.toISOString().slice(0, 10) },
      markerPath
    );
    writeJson(markerPath, marker);
  });
}
