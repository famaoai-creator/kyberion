import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReadFile } from '../secure-io.js';
import type { MissionGateDefinition } from './mission-gate-engine.js';

const GATE_PATH_KEYS = new Set([
  'path',
  'paths',
  'artifact_path',
  'deliverable',
  'evidence_paths',
  'evidencePath',
  'input_paths',
]);

/** CLI, worker evaluation and retry admission resolve the same declared inputs. */
export function normalizeMissionGateCheckPaths(
  gate: MissionGateDefinition,
  missionDirectory: string,
  humanConfirmed = false
): MissionGateDefinition {
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string' && value && !path.isAbsolute(value))
      return path.join(missionDirectory, value);
    return Array.isArray(value) ? value.map(resolve) : value;
  };
  return {
    ...gate,
    checks: gate.checks.map((check) => {
      const params = { ...check.params };
      for (const key of Object.keys(params))
        if (GATE_PATH_KEYS.has(key)) params[key] = resolve(params[key]);
      // Preserve the explicit CLI confirmation behavior; normalizing a worker
      // gate never invents a reviewer/human decision.
      if (humanConfirmed && check.kind === 'reviewer_approved') params.approved = true;
      if (humanConfirmed && check.kind === 'human_override') params.allow = true;
      return { ...check, params };
    }),
  };
}

/** Snapshot only declared inputs. A command without input_paths cannot prove unchanged inputs. */
export function fingerprintMissionGateInputs(
  gate: MissionGateDefinition,
  missionDirectory?: string
): string {
  const normalized = missionDirectory
    ? normalizeMissionGateCheckPaths(gate, missionDirectory)
    : gate;
  // Decisions are enforced by the gate verdict. They are not contract bytes:
  // worker task-board enrichment and CLI confirmation must not make an
  // otherwise unchanged malformed contract appear to have changed.
  const checks = normalized.checks
    .filter((check) => check.kind !== 'reviewer_approved' && check.kind !== 'human_override')
    .map((check) => {
      const params = { ...check.params };
      for (const [key, value] of Object.entries(params)) {
        if (!GATE_PATH_KEYS.has(key)) continue;
        const values = Array.isArray(value) ? value : [value];
        params[key] = values.map((entry) => {
          if (typeof entry !== 'string' || !entry) return { value: entry };
          try {
            const file = assertSafeRepositoryPath(
              missionDirectory && !path.isAbsolute(entry)
                ? path.join(missionDirectory, entry)
                : entry,
              { allowMissingLeaf: true }
            );
            if (!safeExistsSync(file)) return { path: file, state: 'missing' };
            if (!safeLstat(file).isFile()) return { path: file, state: 'not_regular' };
            return {
              path: file,
              sha256: createHash('sha256').update(safeReadFile(file)).digest('hex'),
            };
          } catch {
            // The actual check reports the denial. Fingerprinting never turns a
            // denied/missing input into broader permission or leaks its content.
            return { path: entry, state: 'unavailable' };
          }
        });
      }
      return { kind: check.kind, params };
    });
  return createHash('sha256')
    .update(JSON.stringify({ id: gate.id, checks }))
    .digest('hex');
}
