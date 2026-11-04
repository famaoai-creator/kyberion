/**
 * scripts/customer_decision_overview.ts — read-only customer-decision facade
 * for the Kyberion server (CD-12, MSN-SHELL-UX-20261104).
 *
 *   node dist/scripts/customer_decision_overview.js overview --tenant <t> \
 *     [--summary | --case <id> --detail | --learning [--date <YYYY-MM-DD>]] --json
 *
 * Concierge's `/api/ops/customer-decisions` routes (overview, case, learning)
 * launch this entry under `SYSTEM_ROLE=customer_decision_reader`, whose policy
 * grants only `decision_ledger`. It dispatches the `overview` verb of
 * `pnpm customer-decision` and nothing else, so the reachability analysis
 * bounds the role by the read path alone; every writer verb (draft, respond,
 * learning, …) stays in `scripts/customer_decision.ts`, which this process
 * cannot reach.
 */
import { nowIso } from '@agent/core/foundation';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';
import { parseCustomerDecisionArgs, usageError } from './customer-decision/common.js';
import { runOverview } from './customer-decision/overview.js';

export function runCustomerDecisionOverview(
  argv: readonly string[],
  now: string = nowIso()
): unknown {
  const { verb, opts, flags } = parseCustomerDecisionArgs(argv);
  if (verb !== 'overview')
    throw usageError(`customer_decision_overview runs only the read-only 'overview' verb`);
  return runOverview(opts, flags, now);
}

export const runCustomerDecisionOverviewScript = defineScript({
  name: 'customer-decision-overview',
  flags: ['json', 'quiet'],
  run: async (context) => {
    try {
      const result = await runCustomerDecisionOverview(
        context.argv.filter((arg) => arg !== '--json' && arg !== '--quiet')
      );
      context.print(result);
      return result;
    } catch (error) {
      if (error instanceof ScriptExitError) {
        if (error.returnValue !== undefined) context.print(error.returnValue);
        throw error;
      }
      throw new ScriptExitError(2, error instanceof Error ? error.message : String(error));
    }
  },
});

if (
  isDirectScript(import.meta.url, 'customer_decision_overview.ts') ||
  isDirectScript(import.meta.url, 'customer_decision_overview.js')
) {
  void runCustomerDecisionOverviewScript(currentProcessArgv().slice(2));
}
