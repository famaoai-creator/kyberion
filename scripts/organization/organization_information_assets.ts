import { authorizeInformationAssetManagement } from '@agent/core/information-assets/access';
import { withExecutionContextAsync } from '@agent/core/authority';
import { listWorkItems } from '@agent/core/workforce/work-coordination';
import { findDotCharter } from '@agent/core/dot/dot-charter';
import { evaluateDotFeedTriggers } from '@agent/core/dot/dot-feed-source';
import { runAsDotCharter } from '@agent/core/dot/dot-key-results';
import { executeServicePreset } from '@agent/core/service/service-engine';
import { safeReadFile } from '@agent/core/secure-io';
import {
  projectCommitments,
  renderCommitmentDigest,
  type CommitmentProjectionEntry,
} from '@agent/core/information-assets/work';
import { informationArtifactHash } from '@agent/core/information-assets/completion';
import { parseInformationAssetWorkBinding } from '@agent/core/information-assets/work-types';
/** Owner-authorized CLI for information availability; mutation uses the organization facade. */
import { createStandardYargs } from '@agent/core/cli-utils';
import { resolveScopeContext } from '@agent/core/scope-context';
import { readSafeJsonFile } from '../lib/json-input.js';
import {
  listManagedInformationAssetLocations,
  saveManagedInformationAssetLocation,
  removeManagedInformationAssetLocation,
  resolveManagedInformationAssets,
} from '@agent/core/information-assets/catalog';
import type { InformationAssetLocation } from '@agent/core/information-assets/types';
import {
  informationAssetCollectionStatePath,
  readInformationAssetCollectionCoverage,
} from '@agent/core/information-assets/collector';
import { resolveOrganizationPeopleCliAuthorization } from './organization_people.js';

export async function runOrganizationInformationAssets(
  argv: string[],
  print: (value: unknown) => void
): Promise<void> {
  const defaults = resolveScopeContext();
  const args = await createStandardYargs([
    process.execPath,
    'organization_information_assets.ts',
    ...argv,
  ])
    .scriptName('pnpm organization information-assets')
    .command('$0 [action]', 'Manage scoped information asset locations', (y) =>
      y.positional('action', {
        choices: ['list', 'resolve', 'save', 'remove', 'collect', 'work', 'commitments'],
        default: 'list',
      })
    )
    .option('tenant', { alias: 'tenant-slug', type: 'string', default: defaults.tenant_slug })
    .option('organization-id', { type: 'string', default: defaults.organization_id })
    .option('project-id', { type: 'string', default: defaults.project_id })
    .option('dot', { type: 'string' })
    .option('asset-type', { type: 'string' })
    .option('file', { type: 'string' })
    .option('location-id', { type: 'string' })
    .option('expected-version', { type: 'number' })
    .option('apply', { type: 'boolean', default: false })
    .option('self', {
      type: 'string',
      array: true,
      description: 'Your own email addresses or names, so commitments split into owed vs waiting',
    })
    .option('format', { choices: ['markdown', 'json'] as const, default: 'markdown' as const })
    .strict()
    .parse();
  if (!args.tenant || !args.organizationId)
    throw new Error('Select --tenant and --organization-id.');
  if (args.apply && args.dryRun) throw new Error('Choose --apply or --dry-run.');
  const scope = {
    tenant_slug: args.tenant,
    organization_id: args.organizationId,
    ...(args.projectId ? { project_id: args.projectId } : {}),
  };
  const auth = resolveOrganizationPeopleCliAuthorization(scope.tenant_slug);
  if (args.action === 'list') {
    print(await listManagedInformationAssetLocations(auth, scope));
    return;
  }
  if (args.action === 'resolve') {
    if (!args.assetType) throw new Error('--asset-type is required.');
    print(
      await resolveManagedInformationAssets(
        auth,
        { scope, asset_type: args.assetType },
        {
          coverage: (location) => readInformationAssetCollectionCoverage(location),
          coverageResources: (location) => [informationAssetCollectionStatePath(location)],
        }
      )
    );
    return;
  }
  if (args.action === 'collect' || args.action === 'work' || args.action === 'commitments') {
    // The registered owner and canonical parent scopes are checked before runtime authority.
    const authorized = await authorizeInformationAssetManagement(auth, scope);
    if (authorized.allowedProjectIds !== 'all' && !scope.project_id)
      throw new Error('Select an authorized --project-id for runtime work.');
    await listManagedInformationAssetLocations(auth, scope);
    const result = await withExecutionContextAsync(
      'organization_operator',
      async () => {
        if (args.action === 'commitments') {
          const projection = projectCommitments(collectCommitmentEntries(scope), {
            selfIdentities: args.self ?? [],
          });
          return args.format === 'json' ? projection : renderCommitmentDigest(projection);
        }
        if (args.action === 'work')
          return listWorkItems({
            tenantSlugs: [scope.tenant_slug],
            organizationIds: [scope.organization_id],
            ...(scope.project_id ? { projectIds: [scope.project_id] } : {}),
          })
            .filter((item) => item.metadata?.information_asset_work)
            .map((item) => ({
              item_id: item.item_id,
              status: item.status,
              context: item.context,
              outcome: item.metadata?.information_asset_outcome,
              executor: item.metadata?.dot_executor,
            }));
        if (!args.dot)
          throw new Error('--dot is required for collection through its authorized feed policy.');
        const loaded = findDotCharter(args.dot);
        if (
          !loaded ||
          loaded.charter.scope.tier !== 'confidential' ||
          loaded.charter.scope.tenant_slug !== scope.tenant_slug ||
          loaded.charter.scope.organization_id !== scope.organization_id ||
          loaded.charter.scope.project_id !== scope.project_id
        )
          throw new Error('Dot charter does not match selected entity scope.');
        if (!args.apply) return { dry_run: true, action: 'collect', dot_id: args.dot, scope };
        return runAsDotCharter(loaded.charter, () =>
          evaluateDotFeedTriggers(loaded.charter, {
            serviceCall: (input) =>
              executeServicePreset(
                input.service_id,
                input.action,
                input.params ?? {},
                'secret-guard'
              ),
          })
        );
      },
      undefined,
      scope.tenant_slug,
      scope.organization_id,
      { projectId: scope.project_id ?? null, missionId: null }
    );
    print(result);
    return;
  }
  if (!Number.isInteger(args.expectedVersion) || args.expectedVersion! < 0)
    throw new Error('--expected-version must be a nonnegative integer.');
  const expectedVersion = args.expectedVersion!;
  if (args.action === 'save') {
    if (!args.file) throw new Error('--file is required.');
    const location = readSafeJsonFile<InformationAssetLocation>(
      args.file,
      'Information asset location'
    );
    if (!args.apply) {
      await listManagedInformationAssetLocations(auth, scope);
      print({
        dry_run: true,
        action: 'save',
        scope,
        location_id: location.location_id,
        expectedVersion,
      });
      return;
    }
    print(await saveManagedInformationAssetLocation(auth, { scope, location, expectedVersion }));
    return;
  }
  if (!args.locationId) throw new Error('--location-id is required.');
  if (!args.apply) {
    await listManagedInformationAssetLocations(auth, scope);
    print({
      dry_run: true,
      action: 'remove',
      scope,
      location_id: args.locationId,
      expectedVersion,
    });
    return;
  }
  print(
    await removeManagedInformationAssetLocation(auth, {
      scope,
      location_id: args.locationId,
      expectedVersion,
    })
  );
}

/**
 * Completed intake work whose artifact still matches its recorded hash. A
 * mismatch is surfaced as a skipped entry by the projection, never trusted.
 */
function collectCommitmentEntries(scope: {
  tenant_slug: string;
  organization_id: string;
  project_id?: string;
}): CommitmentProjectionEntry[] {
  const entries: CommitmentProjectionEntry[] = [];
  for (const item of listWorkItems({
    tenantSlugs: [scope.tenant_slug],
    organizationIds: [scope.organization_id],
    ...(scope.project_id ? { projectIds: [scope.project_id] } : {}),
  })) {
    const outcome = item.metadata?.information_asset_outcome as
      | { status?: string; work_key?: string; artifact_ref?: string; evidence_sha256?: string }
      | undefined;
    if (
      !item.metadata?.information_asset_work ||
      outcome?.status !== 'completed' ||
      typeof outcome.artifact_ref !== 'string' ||
      typeof outcome.work_key !== 'string'
    )
      continue;
    let binding: ReturnType<typeof parseInformationAssetWorkBinding>;
    try {
      binding = parseInformationAssetWorkBinding(item.metadata.information_asset_work);
    } catch {
      continue;
    }
    const base = {
      work_item_id: item.item_id,
      work_key: outcome.work_key,
      artifact_ref: outcome.artifact_ref,
    };
    let content: string;
    try {
      content = safeReadFile(outcome.artifact_ref, { encoding: 'utf8' }) as string;
    } catch {
      entries.push({ ...base, artifact: null, error: 'artifact_unreadable' });
      continue;
    }
    if (informationArtifactHash(content) !== outcome.evidence_sha256) {
      entries.push({ ...base, artifact: null, error: 'artifact_hash_mismatch' });
      continue;
    }
    let artifact: { recipe_id?: unknown; subject_id?: unknown } | null;
    try {
      artifact = JSON.parse(content) as { recipe_id?: unknown; subject_id?: unknown } | null;
    } catch {
      entries.push({ ...base, artifact: null, error: 'artifact_not_json' });
      continue;
    }
    // The artifact must describe the same admitted work it is recorded against.
    if (
      outcome.work_key !== binding.work_key ||
      artifact?.recipe_id !== binding.recipe_id ||
      artifact?.subject_id !== binding.observation.subject_id
    ) {
      entries.push({ ...base, artifact: null, error: 'artifact_binding_mismatch' });
      continue;
    }
    entries.push({ ...base, artifact });
  }
  return entries;
}
