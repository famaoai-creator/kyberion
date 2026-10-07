#!/usr/bin/env node
/**
 * Golden-scenario upkeep for procedures.
 *
 *   pnpm kyberion procedure golden status [--json]
 *     Each procedure's check state, most urgent first: missing or weak-only
 *     golden scenario, failed check, reported problem, unconfirmed change.
 *
 *   pnpm kyberion procedure golden backfill [--dry-run] [--catalog <path>] [--json]
 *     Create golden scenarios for procedures promoted before they were stored,
 *     from each procedure's own reviewed recording.
 */
import {
  backfillGoldenScenarios,
  procedureCheckStatus,
  type ProcedureCheckAttention,
} from '@agent/core/knowledge/golden-scenario-maintenance';
import { procedureCatalogPaths } from '@agent/core/knowledge/procedure-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

const USAGE =
  'Usage: pnpm kyberion procedure golden <status|backfill> [--json] [--dry-run] [--catalog <path>]';

const ATTENTION_TEXT: Record<ProcedureCheckAttention, string> = {
  no_golden_scenario: 'no golden scenario — run `pnpm kyberion procedure golden backfill`',
  weak_only: 'golden scenario has no condition that can pass — re-record with a visible result',
  failed_check: 'failed its success check — fix or re-record',
  reported_problem: 'reported wrong/stale — fix or supersede',
  changed_since_verified: 'changed since it last worked — run it to confirm',
  never_passed: 'has not passed its check yet — run it once',
};

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export const runProcedureGolden = defineScript({
  name: 'procedure:golden',
  run(context) {
    const [command] = context.positional.filter((arg) => !arg.startsWith('-'));
    if (command === 'status') {
      const rows = procedureCheckStatus();
      if (context.json) return context.print(rows);
      if (rows.length === 0) return context.print('No procedures in the catalogs.');
      const lines = rows.map((row) => {
        const state = `${row.verification}${row.last_success_at ? ` (last success ${row.last_success_at.slice(0, 10)})` : ''}`;
        const todo = row.attention.map((item) => `\n    - ${ATTENTION_TEXT[item]}`).join('');
        return `${row.procedure_id} [${row.substrate}, ${row.status}] golden=${row.golden} check=${state}${todo}`;
      });
      const needing = rows.filter((row) => row.attention.length > 0).length;
      return context.print(
        [...lines, '', `${needing} of ${rows.length} procedure(s) need attention.`].join('\n')
      );
    }
    if (command === 'backfill') {
      const catalogArg = flagValue(context.argv, '--catalog');
      const catalogs = catalogArg
        ? [
            assertSafeRepositoryPath(pathResolver.rootResolve(catalogArg), {
              allowMissingLeaf: true,
            }),
          ]
        : procedureCatalogPaths();
      const results = catalogs.flatMap((catalogPath) =>
        backfillGoldenScenarios({ catalogPath, dryRun: context.dryRun }).map((result) => ({
          catalog: pathResolver.toRepoRelative(catalogPath),
          ...result,
        }))
      );
      if (context.json) return context.print(results);
      if (results.length === 0)
        return context.print('Every procedure already has a golden scenario.');
      return context.print(
        results
          .map(
            (result) =>
              `${result.action.padEnd(12)} ${result.procedure_id}` +
              (result.golden_scenario_ref ? ` → ${result.golden_scenario_ref}` : '') +
              (result.weak_only ? ' (weak only: no run can pass it)' : '') +
              (result.reason ? ` — ${result.reason}` : '')
          )
          .join('\n')
      );
    }
    throw new Error(USAGE);
  },
});

if (
  isDirectScript(import.meta.url, 'procedure_golden.ts') ||
  isDirectScript(import.meta.url, 'procedure_golden.js')
)
  void runProcedureGolden();
