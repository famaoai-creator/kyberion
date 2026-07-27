/**
 * HO-02: normalize the stores that describe a work handoff into one compact,
 * correlation-keyed timeline. Payload bodies are not copied into the view;
 * only summaries and safe references are retained.
 */

import type { AuditEntry } from './audit-chain.js';
import type { AiDlcPhaseState } from './aidlc-phase-state.js';
import type { CoordinationEvent } from './work-coordination.js';
import type { MissionState } from './mission-types.js';

export type HandoffHistorySource = 'mission' | 'coordination' | 'audit' | 'aidlc';

export interface HandoffHistoryRow {
  timestamp: string;
  source: HandoffHistorySource;
  event: string;
  actor?: string;
  summary: string;
  refs: string[];
}

export interface HandoffHistoryMission {
  missionId: string;
  state: MissionState;
  aidlcState?: AiDlcPhaseState | null;
}

export interface IntegratedHandoffHistoryInput {
  correlationId: string;
  missions?: HandoffHistoryMission[];
  coordinationEvents?: CoordinationEvent[];
  auditEntries?: AuditEntry[];
}

function compact(value: unknown, maxLength = 180): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
  if (!text) return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function timestamp(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '1970-01-01T00:00:00.000Z';
}

function correlationMatches(value: unknown, correlationId: string): boolean {
  if (typeof value === 'string') return value === correlationId;
  if (!value || typeof value !== 'object') return false;
  try {
    return JSON.stringify(value).includes(correlationId);
  } catch {
    return false;
  }
}

function missionMatches(state: MissionState, correlationId: string): boolean {
  if (state.mission_id === correlationId || state.correlation_id === correlationId) return true;
  return (state.history || []).some((entry) =>
    correlationMatches(entry.handoff_packet, correlationId)
  );
}

function missionSummary(state: MissionState, note: string, event: string): string {
  if (state.tier !== 'public') return `[${state.tier} mission event; inspect mission evidence]`;
  return compact(`${event}${note ? `: ${note}` : ''}`) || event;
}

export function buildIntegratedHandoffHistory(
  input: IntegratedHandoffHistoryInput
): HandoffHistoryRow[] {
  const correlationId = String(input.correlationId || '').trim();
  if (!correlationId) return [];
  const rows: HandoffHistoryRow[] = [];

  for (const mission of input.missions || []) {
    if (!missionMatches(mission.state, correlationId)) continue;
    for (const entry of mission.state.history || []) {
      rows.push({
        timestamp: timestamp(entry.ts),
        source: 'mission',
        event: `mission:${entry.event}`,
        actor: entry.from || mission.state.assigned_persona,
        summary: missionSummary(mission.state, entry.note, entry.event),
        refs: [mission.missionId],
      });
    }
    for (const attempt of mission.aidlcState?.attempts || []) {
      rows.push({
        timestamp: timestamp(attempt.at),
        source: 'aidlc',
        event: `aidlc:${attempt.phase}`,
        summary: `phase ${attempt.outcome}${attempt.note ? `: ${compact(attempt.note)}` : ''}`,
        refs: [mission.missionId, 'evidence/aidlc-phase-state.json'],
      });
    }
    if (mission.aidlcState?.failure_context) {
      rows.push({
        timestamp: timestamp(mission.aidlcState.updated_at),
        source: 'aidlc',
        event: 'aidlc:circuit_breaker',
        summary:
          mission.state.tier === 'public'
            ? `returned to alignment: ${compact(mission.aidlcState.failure_context.what_failed)}`
            : `[${mission.state.tier} failure context; inspect mission evidence]`,
        refs: [mission.missionId, 'evidence/aidlc-phase-state.json'],
      });
    }
  }

  for (const event of input.coordinationEvents || []) {
    if (!correlationMatches(event, correlationId)) continue;
    rows.push({
      timestamp: timestamp(event.ts),
      source: 'coordination',
      event: `coordination:${event.event_type}`,
      actor: event.actor_peer_id || event.actor_user_id,
      summary: compact(event.note) || event.event_type,
      refs: [
        ...(event.item_id ? [`item:${event.item_id}`] : []),
        ...(event.lease_id ? [`lease:${event.lease_id}`] : []),
      ],
    });
  }

  for (const entry of input.auditEntries || []) {
    if (
      entry.correlationId !== correlationId &&
      !correlationMatches(entry.metadata, correlationId)
    ) {
      continue;
    }
    rows.push({
      timestamp: timestamp(entry.timestamp),
      source: 'audit',
      event: `audit:${entry.action}`,
      actor: entry.agentId,
      summary: compact(
        `${entry.operation} (${entry.result})${entry.reason ? `: ${entry.reason}` : ''}`
      ),
      refs: [entry.id],
    });
  }

  return rows.sort(
    (left, right) =>
      left.timestamp.localeCompare(right.timestamp) || left.source.localeCompare(right.source)
  );
}

export function formatIntegratedHandoffHistory(
  correlationId: string,
  rows: HandoffHistoryRow[]
): string {
  const lines = [`Integrated work history: ${correlationId}`, `Events: ${rows.length}`];
  if (rows.length === 0) return `${lines.join('\n')}\n(no matching handoff events)`;
  lines.push('');
  for (const row of rows) {
    const actor = row.actor ? ` actor=${row.actor}` : '';
    const refs = row.refs.length ? ` refs=${row.refs.join(',')}` : '';
    lines.push(`${row.timestamp} [${row.source}] ${row.event}${actor} — ${row.summary}${refs}`);
  }
  return lines.join('\n');
}
