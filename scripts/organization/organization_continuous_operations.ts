import { loadContinuousOperationsConfig } from '../continuous/continuous_operations_config.js';
import { runContinuousOperationsCycle } from '../continuous/continuous_operations_cycle.js';
/** Organization facade for the governed, snapshot-based continuous operations loop. */
import { resolveScopeResolution } from '@agent/core/scope-context';
import { withExecutionContextAsync } from '@agent/core/authority';
import { findDotCharter } from '@agent/core/dot/dot-charter';
import { runAsDotCharter } from '@agent/core/dot/dot-key-results';
import { runContinuousManagedOwner } from '../continuous/continuous_work_owner.js';
import { runContinuousOperations } from '@agent/core/organization/continuous-operations';
import { type ContinuousOperationsConfig } from '@agent/core/organization/continuous-operations-policy';

const USAGE =
  'Usage: pnpm organization continuous run --config <governed-config.json> --dry-run|--apply [--recover-admissions] [--json]';

export function assertContinuousOperationsSelectedScope(
  config: ContinuousOperationsConfig,
  selected = resolveScopeResolution().scope
): void {
  const scope = config.scope;
  if (
    selected.tier !== scope.tier ||
    selected.tenant_slug !== scope.tenant_slug ||
    selected.organization_id !== scope.organization_id ||
    selected.project_id !== scope.project_id
  ) {
    throw new Error(
      'Select the matching tier, tenant, organization and project with pnpm scope use before running this loop.'
    );
  }
}

export async function runOrganizationContinuousOwnerTick(
  args: string[],
  print: (value: unknown) => void
): Promise<void> {
  const [configFlag, configRef, itemFlag, itemId] = args;
  if (
    args.length !== 4 ||
    configFlag !== '--config' ||
    !configRef ||
    itemFlag !== '--work-item-id' ||
    !itemId ||
    !/^witem-[a-z0-9-]+$/i.test(itemId)
  ) {
    throw new Error(
      'Usage: pnpm organization continuous owner-tick --config <governed-config.json> --work-item-id <id>'
    );
  }
  const config = loadContinuousOperationsConfig(configRef);
  assertContinuousOperationsSelectedScope(config);
  const { scope } = config;
  const rows = await withExecutionContextAsync(
    'organization_operator',
    async () => {
      const charter = findDotCharter(config.dot_id)?.charter;
      if (!charter || charter.authority.authority_role !== 'organization_operator') {
        throw new Error('Continuous owner tick requires an organization operator charter.');
      }
      assertContinuousOperationsSelectedScope(config, charter.scope);
      return runAsDotCharter(charter, () => runContinuousManagedOwner(charter, { itemId }));
    },
    undefined,
    scope.tenant_slug,
    scope.organization_id
  );
  print(rows);
  if (!rows.length || rows.some((row) => ['blocked', 'failed', 'skipped'].includes(row.status))) {
    throw new Error(
      'Continuous owner tick made no executable progress; inspect the reported state.'
    );
  }
}

export async function runOrganizationContinuousOperations(
  args: string[],
  print: (value: unknown) => void,
  deps: {
    load?: typeof loadContinuousOperationsConfig;
    selectedScope?: typeof assertContinuousOperationsSelectedScope;
    run?: typeof runContinuousOperations;
    bind?: (config: ContinuousOperationsConfig, run: () => unknown) => unknown;
  } = {}
): Promise<void> {
  let configRef: string | undefined;
  let apply = false;
  let dryRun = false;
  let json = false;
  let recoverAdmissions = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(USAGE);
    seen.add(arg);
    if (arg === '--config' && args[i + 1] && !args[i + 1].startsWith('--')) configRef = args[++i];
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--recover-admissions') recoverAdmissions = true;
    else if (arg === '--json') json = true;
    else throw new Error(USAGE);
  }
  if (!configRef || apply === dryRun || (recoverAdmissions && !apply)) throw new Error(USAGE);
  const config = (deps.load ?? loadContinuousOperationsConfig)(configRef);
  (deps.selectedScope ?? assertContinuousOperationsSelectedScope)(config);
  const run = async () =>
    deps.run
      ? deps.run(config, { apply, recoverAdmissions })
      : runContinuousOperationsCycle(config, { apply, recoverAdmissions });
  const result = deps.bind
    ? await deps.bind(config, run)
    : await withExecutionContextAsync(
        'organization_operator',
        run,
        undefined,
        config.scope.tenant_slug,
        config.scope.organization_id
      );
  print(json ? result : { mode: apply ? 'apply' : 'dry_run', report: result });
  if (
    (result as ReturnType<typeof runContinuousOperations>).inventory.some(
      (row) => row.disposition === 'error'
    )
  ) {
    throw new Error('Continuous operations admission failed; inspect the report before retrying.');
  }
}

export {
  loadContinuousOperationsConfig,
  CONTINUOUS_CONFIG_ROOT,
} from '../continuous/continuous_operations_config.js';
export { runContinuousOperationsCycleFromRef } from '../continuous/continuous_operations_cycle.js';

export { runContinuousManagedOwner };
