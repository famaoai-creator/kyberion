// Self-described operation catalog for the working-memory actuator.
// Keep this list aligned with the OPS dispatch table in index.ts and the
// capabilities declared in manifest.json.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

const WORKING_MEMORY_OPS = [
  ['note', 'apply'],
  ['set-now', 'apply'],
  ['add-action-item', 'apply'],
  ['complete-action-item', 'apply'],
  ['daily-open', 'apply'],
  ['todo-add', 'apply'],
  ['todo-done', 'apply'],
  ['todo-rollover', 'apply'],
  ['weekly-open', 'apply'],
  ['nominate-promotion', 'apply'],
  ['run-gc', 'apply'],
  ['build-index', 'apply'],
  ['read', 'capture'],
  ['list', 'capture'],
] as const satisfies ReadonlyArray<readonly [string, OpSpecKind]>;

export function describeOps() {
  return WORKING_MEMORY_OPS.map(([op, kind]) => ({ op, kind }));
}
