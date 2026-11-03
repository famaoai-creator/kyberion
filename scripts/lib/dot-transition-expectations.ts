/**
 * Optimistic controls for a dot status transition. A delegating caller (the
 * Concierge operations console, which validated viewer scope, status and
 * admission hash read-only) passes them so `transitionDotCharterStatus`
 * re-validates inside the charter lock and fails closed with
 * [DOT_TRANSITION_CONFLICT] when the charter changed in between.
 */
import { cliOptionValue } from '@agent/core/cli-guard';
import { parseSafeJsonObjectInput } from '@agent/core/foundation';
import type { DotCharter, DotCharterStatus } from '@agent/core/dot/dot-charter';

export const DOT_TRANSITION_EXPECT_FLAGS = [
  '--expect-status',
  '--expect-admission-hash',
  '--expect-scope-json',
] as const;

const STATUSES: readonly DotCharterStatus[] = ['draft', 'active', 'paused', 'retired'];

export interface DotTransitionExpectations {
  expectedStatus?: DotCharterStatus;
  expectedAdmissionScopeHash?: string;
  expectedScope?: DotCharter['scope'];
}

export function parseTransitionExpectations(argv: readonly string[]): DotTransitionExpectations {
  for (const flag of DOT_TRANSITION_EXPECT_FLAGS) {
    if (argv.includes(flag) && !cliOptionValue(argv, flag))
      throw new Error(`[DOT_TRANSITION_EXPECTATION] ${flag} requires a value`);
  }
  const status = cliOptionValue(argv, '--expect-status');
  const hash = cliOptionValue(argv, '--expect-admission-hash');
  const scope = cliOptionValue(argv, '--expect-scope-json');
  if (status && !STATUSES.includes(status as DotCharterStatus))
    throw new Error(`[DOT_TRANSITION_EXPECTATION] invalid --expect-status '${status}'`);
  if (hash && !/^[A-Za-z0-9:_-]{16,160}$/.test(hash))
    throw new Error('[DOT_TRANSITION_EXPECTATION] invalid --expect-admission-hash');
  const expectedScope = scope
    ? parseSafeJsonObjectInput(scope, 'dot transition --expect-scope-json')
    : undefined;
  return {
    ...(status ? { expectedStatus: status as DotCharterStatus } : {}),
    ...(hash ? { expectedAdmissionScopeHash: hash } : {}),
    ...(expectedScope ? { expectedScope: expectedScope as DotCharter['scope'] } : {}),
  };
}
