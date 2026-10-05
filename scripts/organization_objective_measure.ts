/**
 * `pnpm organization objective kr measure` — measures an organization's
 * objective key results on demand and prints the objective roll-up.
 *
 * Organization KRs are otherwise measured only while an active dot charter
 * references the objective (`measureActiveDotKeyResults`), so an organization
 * run by hand had no way to see its objectives move.
 */
import { measureOrganizationKeyResults } from '@agent/core/dot/dot-key-results';
import { loadOrganizationPurpose } from '@agent/core/organization/organization-operating-model';
import type { OrganizationTier } from '@agent/core/organization/organization-operating-model';
import {
  rollUpObjectiveProgress,
  type OrganizationObjectiveProgress,
} from '@agent/core/organization/organization-objective-progress';

type Print = (value: unknown) => void;

const USAGE =
  'Usage: pnpm organization objective kr measure --organization-id <id> --tier <tier> [--tenant-slug <slug>] --dry-run|--apply [--json]';

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
  deps: { measure?: typeof measureOrganizationKeyResults } = {}
): Promise<void> {
  const organizationId = flag(args, '--organization-id');
  const tier = flag(args, '--tier') as OrganizationTier | undefined;
  const tenantSlug = flag(args, '--tenant-slug');
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  if (!organizationId || !tier || apply === dryRun) throw new Error(USAGE);
  if (tier !== 'public' && !tenantSlug) {
    throw new Error(`A tenant is required for ${tier} organization scope. ${USAGE}`);
  }
  const scope = { organizationId, tier, ...(tenantSlug ? { tenantSlug } : {}) };
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
  const measured = new Map(rows.map((row) => [row.kr_id, row]));
  const progress = rollUpObjectiveProgress(scope, {
    // The rows just written are the latest measurement for each KR.
    readMeasurements: () => rows,
  });
  if (args.includes('--json')) {
    print({ mode: 'apply', organization_id: organizationId, measurements: rows, progress });
    return;
  }
  print(
    [
      `Measured ${rows.length} of ${declared.length} key result(s).`,
      ...declared
        .filter((ref) => !measured.has(ref.split('/')[1]!))
        .map((ref) => `  not measured: ${ref} (not due yet, or its metric could not be read)`),
      ...formatObjectiveProgress(progress),
    ].join('\n')
  );
}
