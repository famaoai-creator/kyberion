import { isDirectEntry } from '@agent/core/direct-entry';
import { defineCatalogBackedActuator } from '../../../core/actuator/actuator-sdk.js';
import { handleAction } from './terminal-actuator-helpers.js';
import { describeOps } from './op-catalog.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

/** Catalog ops served by the computer-interaction contract rather than an action verb. */
const COMPUTER_INTERACTION_OPS = new Set([
  'spawn_terminal',
  'poll_terminal',
  'write_terminal',
  'kill_terminal',
  'list_terminal_sessions',
]);

function terminalActionInput(op: string, params: Record<string, unknown>): unknown {
  if (!COMPUTER_INTERACTION_OPS.has(op)) return { action: op, params };
  const keys = Array.isArray(params.keys) ? params.keys : [];
  return {
    version: '0.1',
    kind: 'computer_interaction',
    ...(typeof params.sessionId === 'string' ? { session_id: params.sessionId } : {}),
    action: {
      type: op,
      shell: params.shell,
      args: params.args,
      cwd: params.cwd,
      thread_id: params.threadId,
      text: params.text,
      ...(typeof keys[0] === 'string' ? { key: keys[0] } : {}),
    },
  };
}

export const actuator = defineCatalogBackedActuator({
  id: 'terminal-actuator',
  describeOps,
  handleAction,
  actionInput: terminalActionInput,
});

const main = async () => {
  await runActuatorCli({
    name: 'terminal-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/terminal-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'terminal-actuator');
}

export { handleAction };
