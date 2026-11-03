#!/usr/bin/env node
import { resolveIdentityContext, withExecutionContextAsync } from '@agent/core/authority';
import { loadState } from '@agent/core/mission/mission-state';
import { createStandardYargs, currentProcessArgv } from '@agent/core/cli-utils';
import {
  runInformationAssetMissionWork,
  resolveInformationAssetMissionExecution,
  type InformationAssetWorkOutcome,
} from '@agent/core/information-assets/work';
import { handleAction } from '../libs/actuators/service-actuator/src/service-actuator-helpers.js';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';
export async function main(
  args: string[] = currentProcessArgv(),
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  const argv = await createStandardYargs(['node', 'information_asset_work', ...args])
    .option('work-item', { type: 'string', demandOption: true })
    .option('plan', { type: 'boolean', default: false })
    .parseAsync();
  const id = String(argv['work-item']);
  const identity = resolveIdentityContext();
  const missionId = identity.missionId;
  if (identity.role !== 'mission_controller' || !missionId || identity.missionId !== missionId)
    throw new Error(
      '[INFORMATION_MISSION_OWNER] Run from the existing mission_controller identity and active MISSION_ID'
    );
  const state = loadState(missionId);
  if (!state || state.status !== 'active' || !state.tenant_slug || !state.organization_id)
    throw new Error('[INFORMATION_MISSION_ACTIVE] An approved active tenant mission is required');
  await withExecutionContextAsync(
    'mission_controller',
    async () => {
      if (argv.plan) {
        print(resolveInformationAssetMissionExecution(id));
        return;
      }
      const result = await runInformationAssetMissionWork(id, async (input) => {
        const result = await handleAction({
          service_id: '',
          mode: 'HARNESS',
          action: 'pipeline',
          params: {},
          steps: [
            {
              op: 'information_asset_work',
              params: {
                work_item_id: input.workItemId,
                attempt_id: input.attemptId,
                lease_id: input.leaseId,
                dot_id: input.dotId,
                actor_id: input.actorId,
              },
            },
          ],
        });
        const envelope = result as Record<string, unknown>;
        return envelope.information_asset_result as InformationAssetWorkOutcome;
      });
      print(result);
    },
    undefined,
    state.tenant_slug,
    state.organization_id,
    { missionId, projectId: state.relationships?.project?.project_id ?? null }
  );
}
export const runInformationAssetWork = defineScript({
  name: 'information-asset:work',
  flags: ['json', 'quiet'],
  run: ({ argv, print }) => main(stripSharedScriptFlags(argv), print),
});
if (
  isDirectScript(import.meta.url, 'information_asset_work.ts') ||
  isDirectScript(import.meta.url, 'information_asset_work.js')
)
  void runInformationAssetWork();
