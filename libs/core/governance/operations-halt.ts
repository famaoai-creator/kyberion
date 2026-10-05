import * as path from 'node:path';
import { auditChain } from './audit-chain.js';
import { readJson, writeJson } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';

const logger = createLogger('operations-halt');

/**
 * Autonomous-operation P1-9: the operator's one-command "stop everything".
 *
 * A halt is a durable flag, not a process kill: every autonomous entry point
 * (dot wakes and executor, work-item claims, decision routing, veto-window
 * auto-proceed) checks it and stands down, while housekeeping, read paths and
 * the operator's own commands keep working so the system can be inspected and
 * resumed. Engaging is deliberately cheap (any authorised chat sender or the
 * CLI); releasing is a CLI act (`pnpm kyberion halt resume`), because stopping
 * is the safe direction and resuming is the risky one.
 *
 * The flag fails closed: an unreadable file counts as halted.
 */

export interface OperationsHaltState {
  halted: boolean;
  since?: string;
  by?: string;
  reason?: string;
  /** Set when the flag file exists but cannot be parsed (treated as halted). */
  unreadable?: boolean;
}

const HALT_REL = 'runtime/governance/operations-halt.json';

function haltPath(rootDir?: string): string {
  return assertSafeRepositoryPath(rootDir ?? path.join(pathResolver.shared(HALT_REL)), {
    allowMissingLeaf: true,
  });
}

export function getOperationsHaltState(options: { rootDir?: string } = {}): OperationsHaltState {
  try {
    const file = haltPath(options.rootDir);
    // `readJson`, not the `...IfPresent` variant: that one turns a corrupt file
    // into "absent", and a halt flag must fail closed.
    if (!safeExistsSync(file)) return { halted: false };
    const state = readJson<OperationsHaltState>(file);
    if (!state || state.halted !== true) return { halted: false };
    return {
      halted: true,
      since: typeof state.since === 'string' ? state.since : undefined,
      by: typeof state.by === 'string' ? state.by : undefined,
      reason: typeof state.reason === 'string' ? state.reason : undefined,
    };
  } catch (error) {
    logger.warn(
      `operations halt flag unreadable — treating as halted | next: pnpm kyberion halt resume | evidence: ${error instanceof Error ? error.message : String(error)}`
    );
    return { halted: true, unreadable: true, reason: 'halt flag unreadable' };
  }
}

export function isOperationsHalted(options: { rootDir?: string } = {}): boolean {
  return getOperationsHaltState(options).halted;
}

export interface OperationsHaltChange {
  state: OperationsHaltState;
  /** False when the state was already as requested (no new audit entry). */
  changed: boolean;
}

export function engageOperationsHalt(input: {
  by: string;
  reason?: string;
  rootDir?: string;
  now?: Date;
}): OperationsHaltChange {
  const current = getOperationsHaltState({ rootDir: input.rootDir });
  if (current.halted && !current.unreadable) return { state: current, changed: false };
  const state: OperationsHaltState = {
    halted: true,
    since: (input.now ?? new Date()).toISOString(),
    by: input.by,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  writeJson(haltPath(input.rootDir), state);
  auditChain.record({
    agentId: input.by,
    action: 'operations_halt',
    operation: 'engage',
    result: 'completed',
    reason: input.reason ?? 'operator halt',
  });
  logger.warn(`operations halted by ${input.by}${input.reason ? `: ${input.reason}` : ''}`);
  return { state, changed: true };
}

export function releaseOperationsHalt(input: {
  by: string;
  rootDir?: string;
}): OperationsHaltChange {
  const current = getOperationsHaltState({ rootDir: input.rootDir });
  if (!current.halted) return { state: current, changed: false };
  const state: OperationsHaltState = { halted: false };
  writeJson(haltPath(input.rootDir), state);
  auditChain.record({
    agentId: input.by,
    action: 'operations_halt',
    operation: 'release',
    result: 'completed',
    reason: 'operator resumed operations',
  });
  logger.warn(`operations resumed by ${input.by}`);
  return { state, changed: true };
}

/** Guard for autonomous entry points: throws while operations are halted. */
export class OperationsHaltedError extends Error {
  readonly code = 'operations_halted';
  constructor(readonly state: OperationsHaltState) {
    super(
      `operations are halted${state.by ? ` by ${state.by}` : ''}${state.reason ? `: ${state.reason}` : ''} | next: pnpm kyberion halt resume`
    );
  }
}

export function assertOperationsNotHalted(options: { rootDir?: string } = {}): void {
  const state = getOperationsHaltState(options);
  if (state.halted) throw new OperationsHaltedError(state);
}
