/**
 * `pnpm organization objective kr measure` — measures an organization's
 * objective key results on demand and prints the objective roll-up.
 * `pnpm organization objective kr record` — records a value measured outside
 * Kyberion (the `manual` source, or an override for any KR).
 *
 * Organization KRs are otherwise measured only while an active dot charter
 * references the objective (`measureActiveDotKeyResults`), so an organization
 * run by hand had no way to see its objectives move.
 */
import {
  measureOrganizationKeyResults,
  readOrganizationKrMeasurements,
  recordOrganizationKeyResult,
} from '@agent/core/dot/dot-key-results';
import { loadOrganizationPurpose } from '@agent/core/organization/organization-operating-model';
import type { OrganizationTier } from '@agent/core/organization/organization-operating-model';
import {
  rollUpObjectiveProgress,
  type OrganizationObjectiveProgress,
} from '@agent/core/organization/organization-objective-progress';

type Print = (value: unknown) => void;

const USAGE =
  'Usage: pnpm organization objective kr measure --organization-id <id> --tier <tier> [--tenant-slug <slug>] --dry-run|--apply [--json]';

const RECORD_USAGE =
  'Usage: pnpm organization objective kr record --organization-id <id> --tier <tier> [--tenant-slug <slug>] --objective-id <id> --kr-id <id> --value <n> [--measured-at <iso>] --dry-run|--apply [--json]';

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

/** One line per objective: progress, then each KR's progress or "unmeasured". */
export function formatObjectiveProgress(progress: OrganizationObjectiveProgress): string[] {
  return progress.objectives.map((objective) => {
    const pct = (value: number | undefined) =>
      value === undefined ? 'unmeasured' : `${Math.round(value * 100)}%`;
    const krs = objective.key_results.length
      ? objective.key_results.map((kr) => `${kr.kr_id} ${pct(kr.progress)}`).join(', ')
      : 'no key results';
    return `Objective: ${objective.title} — ${pct(objective.progress)} (${krs})`;
  });
}

export async function measureOrganizationObjectives(
  args: string[],
  print: Print,
  deps: {
    measure?: typeof measureOrganizationKeyResults;
    readMeasurements?: typeof readOrganizationKrMeasurements;
  } = {}
): Promise<void> {
  const { dryRun, ...scope } = parseScope(args, USAGE);
  const { organizationId, tier, tenantSlug } = scope;
  const purpose = loadOrganizationPurpose(organizationId, { tier, tenantSlug });
  const declared = (purpose?.objectives || []).flatMap((objective) =>
    (objective.key_results || []).map((kr) => `${objective.objective_id}/${kr.kr_id}`)
  );
  if (dryRun) {
    print(
      args.includes('--json')
        ? { mode: 'dry_run', organization_id: organizationId, key_results: declared }
        : declared.length
          ? `Would measure ${declared.length} key result(s): ${declared.join(', ')}`
          : 'No key results declared; add one with `pnpm organization objective kr add`.'
    );
    return;
  }
  const rows = await (deps.measure ?? measureOrganizationKeyResults)(scope);
  const measured = new Set(rows.map((row) => `${row.objective_id}/${row.kr_id}`));
  const manual = new Set(
    (purpose?.objectives || []).flatMap((objective) =>
      (objective.key_results || [])
        .filter((kr) => kr.metric.source === 'manual')
        .map((kr) => `${objective.objective_id}/${kr.kr_id}`)
    )
  );
  // The ledger now holds this sweep's rows plus earlier and hand-recorded values.
  const progress = rollUpObjectiveProgress(scope, {
    readMeasurements: deps.readMeasurements ?? ((s) => readOrganizationKrMeasurements(s)),
  });
  if (args.includes('--json')) {
    print({ mode: 'apply', organization_id: organizationId, measurements: rows, progress });
    return;
  }
  print(
    [
      `Measured ${rows.length} of ${declared.length} key result(s).`,
      ...declared
        .filter((ref) => !measured.has(ref))
        .map((ref) =>
          manual.has(ref)
            ? `  not measured: ${ref} (manual — record it with pnpm organization objective kr record)`
            : `  not measured: ${ref} (not due yet, or its metric could not be read)`
        ),
      ...formatObjectiveProgress(progress),
    ].join('\n')
  );
}

function parseScope(args: string[], usage: string) {
  const organizationId = flag(args, '--organization-id');
  const tier = flag(args, '--tier') as OrganizationTier | undefined;
  const tenantSlug = flag(args, '--tenant-slug');
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  if (!organizationId || !tier || apply === dryRun) throw new Error(usage);
  if (tier !== 'public' && !tenantSlug) {
    throw new Error(`A tenant is required for ${tier} organization scope. ${usage}`);
  }
  return { organizationId, tier, ...(tenantSlug ? { tenantSlug } : {}), dryRun };
}

export function recordOrganizationObjectiveKr(
  args: string[],
  print: Print,
  deps: { record?: typeof recordOrganizationKeyResult } = {}
): void {
  const { dryRun, ...scope } = parseScope(args, RECORD_USAGE);
  const objectiveId = flag(args, '--objective-id');
  const krId = flag(args, '--kr-id');
  const rawValue = args[args.indexOf('--value') + 1];
  const value = args.includes('--value') && rawValue?.trim() ? Number(rawValue) : Number.NaN;
  if (!objectiveId || !krId || !Number.isFinite(value)) throw new Error(RECORD_USAGE);
  const measuredAt = flag(args, '--measured-at');
  const input = { objectiveId, krId, value, ...(measuredAt ? { measuredAt } : {}) };
  if (dryRun) {
    print(
      args.includes('--json')
        ? { mode: 'dry_run', organization_id: scope.organizationId, ...input }
        : `Would record ${objectiveId}/${krId} = ${value}${measuredAt ? ` at ${measuredAt}` : ''}`
    );
    return;
  }
  const row = (deps.record ?? recordOrganizationKeyResult)(scope, input);
  if (args.includes('--json')) {
    print({ mode: 'apply', organization_id: scope.organizationId, measurement: row });
    return;
  }
  const progress = deps.record
    ? undefined
    : rollUpObjectiveProgress(scope, {
        readMeasurements: (s) => readOrganizationKrMeasurements(s),
      });
  print(
    [
      `Recorded ${objectiveId}/${krId} = ${value} (${Math.round(row.progress * 100)}% of target).`,
      ...(progress ? formatObjectiveProgress(progress) : []),
    ].join('\n')
  );
}
