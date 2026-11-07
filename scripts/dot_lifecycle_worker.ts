/**
 * scripts/dot_lifecycle_worker.ts — governed dot lifecycle worker (D3,
 * MSN-KYBERION-SERVER-20261104).
 *
 *   node dist/scripts/dot_lifecycle_worker.js <pause|resume|activate> <dot_id> \
 *     --expect-status <status> --expect-admission-hash <hash> \
 *     --expect-scope-json '<scope>' [--actor <principal>] --json
 *
 * The Kyberion server (Concierge) never assumes the dot lifecycle store roles. Its
 * `/api/ops/workspace/autonomy` route checks the viewer, the workplace scope,
 * the charter status and its admission hash read-only, then launches this
 * worker with `buildSystemRoleLaunchEnv(…, 'dot_lifecycle_worker')`. The worker
 * does only the status transition; every expectation is mandatory and is
 * re-validated inside the charter lock, so a charter that changed in between
 * fails closed with [DOT_TRANSITION_CONFLICT] and nothing is written.
 */
import { cliOptionValue, cliPositionals } from '@agent/core/cli-guard';
import { transitionDotCharterStatus } from '@agent/core/dot/dot-lifecycle';
import type { DotCharterStatus } from '@agent/core/dot/dot-charter';
import { DEFAULT_DAEMONS } from './daemon_watchdog.js';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';
import {
  DOT_TRANSITION_EXPECT_FLAGS,
  parseTransitionExpectations,
} from './lib/dot-transition-expectations.js';

const ACTIONS: Record<string, DotCharterStatus> = {
  pause: 'paused',
  resume: 'active',
  activate: 'active',
};

export interface DotLifecycleWorkerResult {
  ok: true;
  dot_id: string;
  action: string;
  status: DotCharterStatus;
}

export function runDotLifecycleWorker(
  argv: readonly string[],
  transition: typeof transitionDotCharterStatus = transitionDotCharterStatus
): DotLifecycleWorkerResult {
  const [action, dotId] = cliPositionals(argv, [...DOT_TRANSITION_EXPECT_FLAGS, '--actor']);
  const target = action ? ACTIONS[action] : undefined;
  if (!target || !dotId)
    throw new Error(
      'usage: dot_lifecycle_worker <pause|resume|activate> <dot_id> --expect-status <s> --expect-admission-hash <h> --expect-scope-json <json>'
    );
  const expected = parseTransitionExpectations(argv);
  if (!expected.expectedStatus || !expected.expectedAdmissionScopeHash || !expected.expectedScope)
    throw new Error(
      '[DOT_TRANSITION_EXPECTATION] the lifecycle worker requires --expect-status, --expect-admission-hash and --expect-scope-json'
    );
  const actor = cliOptionValue(argv, '--actor');
  const charter = transition(dotId, target, {
    supervisedDaemonIds: DEFAULT_DAEMONS,
    ...expected,
    ...(actor ? { actor } : {}),
  });
  return { ok: true, dot_id: charter.dot_id, action, status: charter.status };
}

export const dotLifecycleWorker = defineScript({
  name: 'dot-lifecycle-worker',
  flags: ['json'],
  run(context) {
    const result = runDotLifecycleWorker(stripSharedScriptFlags(context.argv));
    context.print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'dot_lifecycle_worker.ts') ||
  isDirectScript(import.meta.url, 'dot_lifecycle_worker.js')
) {
  void dotLifecycleWorker();
}
