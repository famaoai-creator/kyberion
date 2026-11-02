import * as path from 'node:path';
import { safeExistsSync } from '../secure-io.js';
import { readJson, writeJson } from '../foundation/json.js';
import { dotStatePath } from '../dot/dot-state-paths.js';
import { pathResolver } from '../path-resolver.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { DueDotTrigger } from '../dot/dot-runtime.js';
import type { DotProposal } from '../dot/dot-proposals.js';
import type { InformationAssetObservation } from './types.js';
import { authorizeInformationAssetCapture, readInformationAssetCatalog } from './catalog.js';
import { getInformationAssetCollector, readInformationAssetObservation } from './collector.js';
import { buildInformationAssetRecipeProposals } from './recipes.js';

interface WakeReference {
  version: 1;
  intake_event_id: string;
  source: string;
  location_id: string;
  observation_event_id: string;
}
function referencePath(charter: DotCharter, id: string, rootDir = pathResolver.rootDir()): string {
  if (!/^evt_[a-f0-9]{24}$/.test(id)) throw new Error('information_asset_invalid_intake_event_id');
  return path.join(
    rootDir,
    dotStatePath(charter, 'information-assets', 'wake-events', id + '.json')
  );
}
/** Only the trusted collector publication path writes this pointer; webhook bodies never create it. */
export function recordInformationAssetWakeReference(
  charter: DotCharter,
  source: string,
  intakeEventId: string,
  observation: InformationAssetObservation,
  rootDir?: string
): void {
  const row: WakeReference = {
    version: 1,
    intake_event_id: intakeEventId,
    source,
    location_id: observation.location_id,
    observation_event_id: observation.event_id,
  };
  writeJson(referencePath(charter, intakeEventId, rootDir), row);
}
/** undefined keeps ordinary event/model wakes intact; [] is a valid typed wake with no matching recipe. */
export async function buildTrustedInformationAssetWakeProposals(
  charter: DotCharter,
  trigger: DueDotTrigger | undefined,
  rootDir?: string
): Promise<DotProposal[] | undefined> {
  if (trigger?.trigger.kind !== 'event' || !trigger.key.startsWith('event:')) return undefined;
  const intakeEventId = trigger.key.split(':').at(-1)!;
  if (!/^evt_[a-f0-9]{24}$/.test(intakeEventId)) return undefined;
  const file = referencePath(charter, intakeEventId, rootDir);
  if (!safeExistsSync(file)) return undefined;
  const row = readJson<WakeReference>(file, { maxSizeMB: 1 });
  if (
    row.version !== 1 ||
    row.intake_event_id !== intakeEventId ||
    !trigger.trigger.sources.includes(row.source)
  )
    throw new Error('information_asset_wake_reference_corrupt');
  const feed = charter.attention.triggers.find(
    (item) =>
      item.kind === 'feed' &&
      item.source === row.source &&
      item.collector?.location_id === row.location_id
  );
  if (!feed || feed.kind !== 'feed' || !charter.scope.tenant_slug || !charter.scope.organization_id)
    throw new Error('information_asset_wake_feed_scope_changed');
  const scope = {
    tenant_slug: charter.scope.tenant_slug,
    organization_id: charter.scope.organization_id,
    ...(charter.scope.project_id ? { project_id: charter.scope.project_id } : {}),
  };
  const location = readInformationAssetCatalog(scope, { rootDir }).locations.find(
    (item) => item.location_id === row.location_id
  );
  if (
    !location ||
    location.scope.project_id !== scope.project_id ||
    location.service_id !== feed.service_id
  )
    throw new Error('information_asset_wake_location_changed');
  const adapter = getInformationAssetCollector(location.collector_id);
  if (adapter.actions[0] !== feed.action)
    throw new Error('information_asset_wake_operation_changed');
  await authorizeInformationAssetCapture(scope, location.location_id, adapter.actions[0]!, {
    rootDir,
  });
  const observation = readInformationAssetObservation(location, row.observation_event_id, rootDir);
  if (!observation) throw new Error('information_asset_wake_observation_missing');
  return buildInformationAssetRecipeProposals(observation, charter, { rootDir });
}
