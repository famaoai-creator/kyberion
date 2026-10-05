import {
  engageOperationsHalt,
  getOperationsHaltState,
  releaseOperationsHalt,
  type OperationsHaltState,
} from '@agent/core/governance/operations-halt';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * Autonomous-operation P1-9: the operator's "stop everything" switch.
 *
 *   node dist/scripts/operations_halt.js status
 *   node dist/scripts/operations_halt.js engage [--reason "<why>"]
 *   node dist/scripts/operations_halt.js resume
 *
 * While halted, new work claims are refused, dots stop waking, decision routing
 * parks everything and veto windows stop auto-proceeding. Housekeeping and read
 * paths keep working. See libs/core/governance/operations-halt.ts.
 */

const OPERATOR_ACTOR = 'operator:cli';

function readReason(argv: string[]): string | undefined {
  const index = argv.indexOf('--reason');
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new ScriptExitError(2, '--reason requires a value');
  return value;
}

export function formatOperationsHaltState(state: OperationsHaltState): string {
  if (!state.halted) return 'Operations are running (not halted).';
  const parts = ['Operations are HALTED'];
  if (state.since) parts.push(`since ${state.since}`);
  if (state.by) parts.push(`by ${state.by}`);
  const head = parts.join(' ');
  const reason = state.reason ? `\nReason: ${state.reason}` : '';
  return `${head}.${reason}\nResume with: pnpm kyberion halt resume`;
}

export const runOperationsHalt = defineScript({
  name: 'operations-halt',
  flags: ['json'],
  run(context) {
    const first = context.argv[0];
    const command = first && !first.startsWith('--') ? first : 'status';
    let state: OperationsHaltState;
    if (command === 'status') {
      state = getOperationsHaltState();
    } else if (command === 'engage') {
      state = engageOperationsHalt({ by: OPERATOR_ACTOR, reason: readReason(context.argv) }).state;
    } else if (command === 'resume') {
      state = releaseOperationsHalt({ by: OPERATOR_ACTOR }).state;
    } else {
      throw new ScriptExitError(2, `Unknown halt command: ${command} (status | engage | resume)`);
    }
    context.print(context.json ? JSON.stringify(state, null, 2) : formatOperationsHaltState(state));
    return state;
  },
});

if (
  isDirectScript(import.meta.url, 'operations_halt.ts') ||
  isDirectScript(import.meta.url, 'operations_halt.js')
)
  void runOperationsHalt();
