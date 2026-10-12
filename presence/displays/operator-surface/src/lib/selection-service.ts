import { withExecutionContextAsync } from '@agent/core/authority';
import {
  missionLifecycleService,
  resolveMissionTeamSelectionScope,
} from '@agent/core/mission/mission-lifecycle-service';
import {
  getReasoningSelectionSettings,
  previewReasoningSelection,
  saveReasoningSelection,
} from '@agent/core/reasoning/reasoning-selection-settings';
import type { MissionState } from '@agent/core/mission/mission-types';
import type { OperatorViewer } from './viewer-context';
import {
  isGlobalSelectionAdmin,
  isSelectionAdmin,
  requireSelectionMission,
  SelectionAccessError,
} from './selection-scope';
import type {
  SelectionCommand,
  SelectionRequest,
  SelectionRow,
  SelectionSnapshot,
} from './selection-contract';

type MissionView = ReturnType<typeof missionLifecycleService.previewTeamSelection>;
type ReasoningView = ReturnType<typeof getReasoningSelectionSettings>;

function missionScope(state: MissionState) {
  return resolveMissionTeamSelectionScope(state);
}
function missionSnapshot(view: MissionView, canEdit: boolean): SelectionSnapshot {
  return {
    revision: view.revision,
    previewToken: view.preview_token,
    canEdit,
    rows: view.roles.map((row): SelectionRow => ({
      role: row.team_role,
      requested: {
        mode: row.configured.mode,
        agent_id: row.configured.agent_id,
        provider: row.configured.provider,
        model: row.configured.model_id,
      },
      effective: row.effective.agent_id
        ? {
            agent_id: row.effective.agent_id,
            provider: row.effective.provider ?? undefined,
            model: row.effective.model_id ?? undefined,
          }
        : null,
      source: row.source,
      reason: row.reason,
      valid: row.source !== 'blocked' && row.eligibility?.eligible !== false,
      eligibility: row.eligibility
        ? { eligible: row.eligibility.eligible, reason: row.eligibility.reason.slice(0, 500) }
        : undefined,
      fallback: row.source === 'fallback',
      choices: row.candidates.map((candidate) => ({
        value: candidate.agent_id,
        provider: candidate.provider ?? undefined,
        model: candidate.model_id ?? undefined,
        eligible: candidate.eligible,
        reason: candidate.reason,
      })),
    })),
  };
}
function reasoningSnapshot(view: ReasoningView, canEdit: boolean): SelectionSnapshot {
  return {
    revision: String(view.revision),
    canEdit,
    rows: view.roles.map((row): SelectionRow => ({
      role: row.role,
      requested: row.requested ?? null,
      effective: row.effective,
      source: row.source,
      reason: row.reason,
      valid: row.valid,
      fallback: row.fallback,
      conflict: row.reasonCode === 'conflict',
      details: (row.rejectedCandidates ?? []).slice(0, 8).map((candidate) => ({
        target: candidate.profile.slice(0, 160),
        reason: candidate.reason.slice(0, 500),
      })),
      choices: view.choices.map((choice) => ({
        value: choice.runtime_mode,
        provider: choice.provider,
        models: choice.models,
        profiles: choice.profiles,
        eligible: choice.available,
        reason: choice.reason,
      })),
    })),
  };
}
function toMissionSelection(selection: SelectionRequest) {
  return {
    mode: selection.mode,
    ...(selection.agent_id ? { agent_id: selection.agent_id } : {}),
    ...(selection.provider ? { provider: selection.provider } : {}),
    ...(selection.model ? { model_id: selection.model } : {}),
  };
}
function toReasoningSelection(selection: SelectionRequest) {
  return {
    mode: selection.mode,
    ...(selection.runtime_mode ? { runtime_mode: selection.runtime_mode } : {}),
    ...(selection.provider ? { provider: selection.provider } : {}),
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.profile ? { profile: selection.profile } : {}),
  };
}

export function getMissionSelectionSnapshot(viewer: OperatorViewer, id: string): SelectionSnapshot {
  const state = requireSelectionMission(viewer, id);
  return missionSnapshot(
    missionLifecycleService.previewTeamSelection(id, { expected_scope: missionScope(state) }),
    isSelectionAdmin(viewer)
  );
}
export function getReasoningSelectionSnapshot(viewer: OperatorViewer): SelectionSnapshot {
  return reasoningSnapshot(getReasoningSelectionSettings(), isGlobalSelectionAdmin(viewer));
}

export async function changeMissionSelection(
  viewer: OperatorViewer,
  id: string,
  command: SelectionCommand
): Promise<SelectionSnapshot> {
  if (!isSelectionAdmin(viewer)) throw new SelectionAccessError(403, 'ADMIN_REQUIRED');
  // Resolve and authorize the actual mission before the privileged context is entered.
  const state = requireSelectionMission(viewer, id);
  const input = {
    team_role: command.role,
    selection: toMissionSelection(command.selection),
    expected_scope: missionScope(state),
  };
  if (command.action === 'preview') {
    const view = missionLifecycleService.previewTeamSelection(id, input);
    if (view.revision !== command.expectedRevision)
      throw new SelectionAccessError(409, 'STALE_SELECTION');
    return missionSnapshot(view, true);
  }
  const expectedPreviewToken = command.expectedPreviewToken;
  if (!expectedPreviewToken || !/^[a-f0-9]{64}$/.test(expectedPreviewToken))
    throw new SelectionAccessError(400, 'PREVIEW_REQUIRED');
  const view = await withExecutionContextAsync('mission_controller', () =>
    missionLifecycleService.saveTeamSelection(
      id,
      {
        ...input,
        expected_revision: command.expectedRevision,
        expected_preview_token: expectedPreviewToken,
      },
      {
        surface: 'operator-surface',
        actorId: viewer.principalId,
        ...(viewer.memberId
          ? { decidedBy: { kind: 'human' as const, id: 'user:' + viewer.memberId } }
          : {}),
      }
    )
  );
  return missionSnapshot(view, true);
}

export async function changeReasoningSelection(
  viewer: OperatorViewer,
  command: SelectionCommand
): Promise<SelectionSnapshot> {
  if (!isGlobalSelectionAdmin(viewer)) throw new SelectionAccessError(403, 'GLOBAL_ADMIN_REQUIRED');
  const expectedRevision = Number(command.expectedRevision);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    String(expectedRevision) !== command.expectedRevision
  )
    throw new SelectionAccessError(400, 'INVALID_REVISION');
  const selection = toReasoningSelection(command.selection);
  if (command.action === 'preview') {
    const view = getReasoningSelectionSettings();
    if (view.revision !== expectedRevision) throw new SelectionAccessError(409, 'STALE_SELECTION');
    const preview = previewReasoningSelection({ role: command.role, selection });
    if (getReasoningSelectionSettings().revision !== expectedRevision)
      throw new SelectionAccessError(409, 'STALE_SELECTION');
    return reasoningSnapshot(
      { ...view, roles: view.roles.map((row) => (row.role === command.role ? preview : row)) },
      true
    );
  }
  // Reject already-stale requests before role entry; the store repeats CAS under its lock.
  if (getReasoningSelectionSettings().revision !== expectedRevision)
    throw new SelectionAccessError(409, 'STALE_SELECTION');
  const saved = await withExecutionContextAsync('reasoning_settings_writer', () =>
    saveReasoningSelection({
      role: command.role,
      selection,
      expectedRevision,
      actorId: viewer.principalId,
    })
  );
  return reasoningSnapshot(saved, true);
}
