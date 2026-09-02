import { appendJsonLine } from './foundation/json.js';
import { nowIso } from './foundation/time.js';
import { resolveSharedObservabilityDir } from './observability-gate.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeMkdir } from './secure-io.js';
import * as path from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('agent-runtime-supervisor');
const EVENTS_DIR = pathResolver.shared('observability/mission-control');
let eventWriteWarned = false;

/** Append a best-effort, tenant-scoped runtime supervision event. */
export function appendSupervisorEvent(event: Record<string, unknown>): void {
  try {
    const obsDir = resolveSharedObservabilityDir(EVENTS_DIR);
    if (!obsDir) return;
    const safeObsDir = assertSafeRepositoryPath(obsDir, { allowMissingLeaf: true });
    safeMkdir(safeObsDir);
    appendJsonLine(
      assertSafeRepositoryPath(path.join(safeObsDir, 'agent-runtime-supervisor-events.jsonl'), {
        allowMissingLeaf: true,
      }),
      {
        ts: nowIso(),
        ...event,
      }
    );
  } catch (error: any) {
    // Runtime control must still succeed when a narrow authority cannot write
    // the optional observability stream.
    if (!eventWriteWarned) {
      eventWriteWarned = true;
      logger.warn(`failed to write supervisor event: ${error?.message || error}`);
    }
  }
}
