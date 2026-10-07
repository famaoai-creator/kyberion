import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './meeting-actuator-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '../../../core/actuator/actuator-sdk.js';
import { describeOps } from './op-catalog.js';

const main = async () => {
  await runActuatorCli({
    name: 'meeting-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/meeting-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'meeting-actuator');
}

export { handleAction };
export {
  checkSpeakConsent,
  parseMeetingActionInput,
  parseMeetingActionResult,
} from './meeting-actuator-helpers.js';
export {
  dispatchMeetingIntelligenceOp,
  isMeetingIntelligenceOp,
  isMeetingSessionOp,
  MEETING_ALL_SINGLE_OPS,
  MEETING_INTELLIGENCE_OPS,
  MEETING_SESSION_OPS,
} from './meeting-op-dispatch.js';
export {
  listMeetingProviderAdapters,
  resolveMeetingProvider,
} from './meeting-provider-adapters.js';
export { extractMeetingUrl, resolveNextMeetingTarget } from './meeting-target-resolve.js';
export { normalizeTranscriptText } from './transcript-normalize.js';
export type {
  MeetingAction,
  MeetingActionResult,
  MeetingInput,
  MeetingOpAction,
  MeetingPipelineAction,
} from './meeting-types.js';

export const actuator = defineCatalogBackedActuator({
  id: 'meeting-actuator',
  describeOps,
  // SDK dispatch is catalog-style `{ op, params }`; the helper accepts
  // it directly alongside legacy `{ action, params }` and pipelines.
  actionInput: (op, params) => ({ op, params }),
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
