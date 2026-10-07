/**
 * Meeting op dispatch table — one owner for every non-transport op.
 *
 * Pipeline `apply` steps and direct `{ op, params }` calls share this
 * table so `meeting:extract_action_items` behaves identically from a
 * pipeline, ADF, or the SDK `actuator.dispatch()` path.
 */
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeWriteFile,
  safeExistsSync,
  safeLstat,
} from '@agent/core/secure-io';
import type { ActionItem } from '@agent/core/action-item-store';
import { pathResolver } from '@agent/core/path-resolver';
import { getRegisteredEnvText } from '@agent/core/foundation';
import {
  auditSpeakerFairnessOp,
  conduct1on1,
  executeSelfActionItemsOp,
  extractActionItemsOp,
  generateFacilitationScriptOp,
  generateReminderMessageOp,
  runActionItemReminderSweepOp,
  trackPendingActionItemsOp,
} from './meeting-intelligence-ops.js';
import { hearingSessionOp, tutorSessionOp } from './meeting-guided-dialogue.js';
import { normalizeTranscriptText } from './transcript-normalize.js';
import { resolveNextMeetingTarget, type CalendarLikeEvent } from './meeting-target-resolve.js';

export const MEETING_SESSION_OPS = [
  'check_consent',
  'join',
  'leave',
  'speak',
  'listen',
  'chat',
  'status',
] as const;

export type MeetingSessionOp = (typeof MEETING_SESSION_OPS)[number];

export const MEETING_INTELLIGENCE_OPS = [
  'audit_speaker_fairness',
  'conduct_1on_1',
  'execute_self_action_items',
  'extract_action_items',
  'generate_facilitation_script',
  'generate_reminder_message',
  'hearing_session',
  'tutor_session',
  'normalize_transcript',
  'resolve_next_target',
  'run_action_item_reminder_sweep',
  'track_pending_action_items',
] as const;

export type MeetingIntelligenceOp = (typeof MEETING_INTELLIGENCE_OPS)[number];

export const MEETING_ALL_SINGLE_OPS: readonly string[] = [
  ...MEETING_SESSION_OPS,
  ...MEETING_INTELLIGENCE_OPS,
];

function resolveExistingMeetingFile(ref: string, label: string): string {
  const resolved = assertSafeRepositoryPath(pathResolver.rootResolve(ref), {
    allowMissingLeaf: false,
  });
  if (!safeExistsSync(resolved) || !safeLstat(resolved).isFile()) {
    throw new Error(`[MEETING_RESOURCE_FILE] ${label} must be a regular file: ${ref}`);
  }
  return resolved;
}

function resolveMeetingPath(ref: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), { allowMissingLeaf });
}

function meetingContextIds(
  params: Record<string, unknown>,
  context: Record<string, unknown>
): {
  missionId: string;
  workItemId: string | undefined;
} {
  const missionId = String(params.mission_id ?? getRegisteredEnvText('MISSION_ID') ?? '');
  const workItemId = String(params.work_item_id ?? context.work_item_id ?? '').trim() || undefined;
  return { missionId, workItemId };
}

/**
 * Execute one intelligence / target / dialogue op. Pure dispatch —
 * transport ops (`join`, `speak`, …) are owned by meeting-session and
 * never reach here.
 */
export async function dispatchMeetingIntelligenceOp(
  op: string,
  rawParams: Record<string, unknown>,
  context: Record<string, unknown> = {}
): Promise<unknown> {
  const params = rawParams;
  const { missionId, workItemId } = meetingContextIds(params, context);
  switch (op) {
    case 'conduct_1on_1':
      return conduct1on1({
        counterparty_ref: String(params.counterparty_ref || ''),
        proposal_draft_ref: String(params.proposal_draft_ref || ''),
        structure: Array.isArray(params.structure) ? params.structure.map(String) : [],
        output_path: String(params.output_path || ''),
      });
    case 'hearing_session': {
      return hearingSessionOp({
        topic: String(params.topic || ''),
        ...(params.counterparty_label
          ? { counterparty_label: String(params.counterparty_label) }
          : {}),
        ...(params.context ? { context: String(params.context) } : {}),
        ...(Array.isArray(params.answers) ? { answers: params.answers } : {}),
        ...(missionId ? { mission_id: missionId } : {}),
        ...(workItemId ? { work_item_id: workItemId } : {}),
        ...(params.output_path ? { output_path: String(params.output_path) } : {}),
        ...(params.language ? { language: String(params.language) } : {}),
      });
    }
    case 'tutor_session': {
      const materialPath = params.material_path ? String(params.material_path) : '';
      const material = materialPath
        ? String(
            safeReadFile(resolveExistingMeetingFile(materialPath, 'material_path'), {
              encoding: 'utf8',
            })
          )
        : String(params.material || '');
      return tutorSessionOp({
        material,
        ...(params.learner_label ? { learner_label: String(params.learner_label) } : {}),
        ...(params.goal ? { goal: String(params.goal) } : {}),
        ...(Array.isArray(params.answers) ? { answers: params.answers } : {}),
        ...(missionId ? { mission_id: missionId } : {}),
        ...(workItemId ? { work_item_id: workItemId } : {}),
        ...(params.output_path ? { output_path: String(params.output_path) } : {}),
        ...(params.language ? { language: String(params.language) } : {}),
      });
    }
    case 'extract_action_items': {
      const transcriptPath = params.transcript_path ? String(params.transcript_path) : '';
      const transcript = transcriptPath
        ? String(
            safeReadFile(resolveExistingMeetingFile(transcriptPath, 'transcript_path'), {
              encoding: 'utf8',
            })
          )
        : String(params.transcript || '');
      const attendees = (
        Array.isArray(params.attendees)
          ? params.attendees
          : Array.isArray(context[String(params.attendees_from || 'attendees')])
            ? context[String(params.attendees_from || 'attendees')]
            : []
      ) as Array<{
        name: string;
        person_slug?: string;
        channel_handle?: string;
        manager_handle?: string;
      }>;
      const listenResult = context.listen_result || context.meeting_listen_result;
      const partialState =
        params.partial_state !== undefined
          ? Boolean(params.partial_state)
          : Boolean(
              listenResult &&
              typeof listenResult === 'object' &&
              (listenResult as { partial_state?: unknown }).partial_state
            );
      const partialReason =
        params.partial_reason !== undefined
          ? String(params.partial_reason || '')
          : listenResult && typeof listenResult === 'object'
            ? String((listenResult as { partial_reason?: unknown }).partial_reason || '')
            : undefined;
      const result = await extractActionItemsOp({
        mission_id: missionId,
        ...(workItemId ? { work_item_id: workItemId } : {}),
        transcript,
        attendees,
        ...(params.operator_label ? { operator_label: String(params.operator_label) } : {}),
        ...(params.default_assignee_label
          ? { default_assignee_label: String(params.default_assignee_label) }
          : {}),
        ...(params.language ? { language: String(params.language) } : {}),
        ...(partialState ? { partial_state: true } : {}),
        ...(partialReason ? { partial_reason: partialReason } : {}),
        ...(params.enforce_restricted_actions !== undefined
          ? { enforce_restricted_actions: Boolean(params.enforce_restricted_actions) }
          : {}),
      });
      if (params.output_path) {
        safeWriteFile(
          resolveMeetingPath(String(params.output_path)),
          JSON.stringify(result, null, 2)
        );
      }
      return result;
    }
    case 'normalize_transcript': {
      const transcriptPath = params.transcript_path ? String(params.transcript_path) : '';
      const raw = transcriptPath
        ? String(
            safeReadFile(resolveExistingMeetingFile(transcriptPath, 'transcript_path'), {
              encoding: 'utf8',
            })
          )
        : String(params.transcript || '');
      const attendees = (
        Array.isArray(params.attendees)
          ? params.attendees
          : Array.isArray(context[String(params.attendees_from || 'attendees')])
            ? context[String(params.attendees_from || 'attendees')]
            : []
      ) as Array<string | { name?: string }>;
      const speakerAliases =
        params.speaker_aliases && typeof params.speaker_aliases === 'object'
          ? (params.speaker_aliases as Record<string, string>)
          : {};
      return normalizeTranscriptText(raw, { attendees, speakerAliases }, transcriptPath);
    }
    case 'resolve_next_target': {
      const events = (
        Array.isArray(params.events)
          ? params.events
          : Array.isArray(context[String(params.events_from || 'events')])
            ? context[String(params.events_from || 'events')]
            : []
      ) as CalendarLikeEvent[];
      return resolveNextMeetingTarget(events, {
        ...(params.now !== undefined ? { now: params.now as string | number } : {}),
        ...(params.started_ago_min !== undefined
          ? { started_ago_min: Number(params.started_ago_min) }
          : {}),
        ...(params.starts_within_min !== undefined
          ? { starts_within_min: Number(params.starts_within_min) }
          : {}),
        ...(params.max_duration_sec !== undefined
          ? { max_duration_sec: Number(params.max_duration_sec) }
          : {}),
      });
    }
    case 'generate_facilitation_script':
      return generateFacilitationScriptOp({
        ...(missionId ? { mission_id: missionId } : {}),
        ...(workItemId ? { work_item_id: workItemId } : {}),
        agenda: Array.isArray(params.agenda) ? params.agenda.map(String) : undefined,
        ...(params.current_topic ? { current_topic: String(params.current_topic) } : {}),
        ...(params.recent_transcript_chunk
          ? { recent_transcript_chunk: String(params.recent_transcript_chunk) }
          : {}),
        ...(params.remaining_minutes !== undefined
          ? { remaining_minutes: Number(params.remaining_minutes) }
          : {}),
        ...(params.facilitator_persona_label
          ? { facilitator_persona_label: String(params.facilitator_persona_label) }
          : {}),
        ...(params.language ? { language: String(params.language) } : {}),
      });
    case 'generate_reminder_message': {
      const item = params.item || context[String(params.item_from || 'item')];
      if (!item || typeof item !== 'object') {
        throw new Error('generate_reminder_message: missing params.item (ActionItem)');
      }
      return generateReminderMessageOp({
        item: item as ActionItem,
        ...(missionId ? { mission_id: missionId } : {}),
        ...(workItemId ? { work_item_id: workItemId } : {}),
        ...(params.days_overdue !== undefined ? { days_overdue: Number(params.days_overdue) } : {}),
        ...(params.tone ? { tone: params.tone as 'friendly' | 'formal' | 'urgent' } : {}),
        ...(params.language ? { language: String(params.language) } : {}),
      });
    }
    case 'run_action_item_reminder_sweep':
      return runActionItemReminderSweepOp({
        ...(Array.isArray(params.mission_ids)
          ? { mission_ids: params.mission_ids.map(String) }
          : {}),
        tone: params.tone as 'friendly' | 'formal' | 'urgent' | undefined,
        language: String(params.language || 'ja'),
        max_items_per_mission: Number(params.max_items || 20),
        ...(params.report_path ? { report_path: String(params.report_path) } : {}),
      });
    case 'execute_self_action_items': {
      if (!missionId) throw new Error('execute_self_action_items: mission_id is required');
      const result = await executeSelfActionItemsOp({
        mission_id: missionId,
        ...(workItemId ? { work_item_id: workItemId } : {}),
        language: String(params.language || 'ja'),
      });
      if (params.output_path) {
        safeWriteFile(
          resolveMeetingPath(String(params.output_path)),
          JSON.stringify(result, null, 2)
        );
      }
      return result;
    }
    case 'track_pending_action_items': {
      if (!missionId) throw new Error('track_pending_action_items: mission_id is required');
      return trackPendingActionItemsOp({
        mission_id: missionId,
        ...(workItemId ? { work_item_id: workItemId } : {}),
        tone: params.tone as 'friendly' | 'formal' | 'urgent' | undefined,
        language: String(params.language || 'ja'),
        max_items: Number(params.max_items || 20),
      });
    }
    case 'audit_speaker_fairness': {
      if (!missionId) throw new Error('audit_speaker_fairness: mission_id is required');
      const report = auditSpeakerFairnessOp({ mission_id: missionId });
      if (params.output_path) {
        safeWriteFile(
          resolveMeetingPath(String(params.output_path)),
          JSON.stringify(report, null, 2)
        );
      }
      return report;
    }
    default:
      throw new Error(`[UNKNOWN_OP] Unknown meeting op: ${op}`);
  }
}

export function isMeetingIntelligenceOp(op: string): boolean {
  return (MEETING_INTELLIGENCE_OPS as readonly string[]).includes(op);
}

export function isMeetingSessionOp(op: string): boolean {
  return (MEETING_SESSION_OPS as readonly string[]).includes(op);
}

export { resolveMeetingPath };
