import { pathResolver, safeExistsSync, safeReadFile, safeReaddir } from "@agent/core";

export interface OrchestrationEventSummary {
  ts: string;
  decision: string;
  mission_id?: string;
  why?: string;
}

export interface ControlActionSummary {
  event_id?: string;
  ts: string;
  kind: "mission" | "surface";
  target: string;
  operation: string;
  status: "queued" | "completed" | "failed";
  requested_by: string;
  error?: string;
}

export interface ControlActionDetail {
  ts: string;
  decision: string;
  event_type?: string;
  mission_id?: string;
  resource_id?: string;
  operation?: string;
  why?: string;
  error?: string;
}

export interface OwnerSummary {
  ts: string;
  mission_id: string;
  accepted_count: number;
  reviewed_count: number;
  completed_count: number;
  requested_count: number;
}

export interface BrowserSessionSummary {
  session_id: string;
  active_tab_id: string;
  tab_count: number;
  updated_at: string;
  last_trace_path?: string;
  lease_expires_at?: string;
  lease_status: "active" | "released" | "expired";
  retained: boolean;
  action_trail_count: number;
  recent_actions: Array<{
    op: string;
    kind: "control" | "capture" | "apply";
    tab_id?: string;
    ref?: string;
    selector?: string;
    ts: string;
  }>;
}

export interface BrowserConversationSessionSummary {
  session_id: string;
  surface: string;
  status: string;
  mode: string;
  updated_at: string;
  goal_summary: string;
  active_step?: string;
  pending_confirmation: boolean;
  candidate_target_count: number;
}

export function collectRecentEvents(): OrchestrationEventSummary[] {
  const files = [
    pathResolver.shared("observability/channels/slack/missions.jsonl"),
    pathResolver.shared("observability/mission-control/orchestration-events.jsonl"),
  ];
  const lines: OrchestrationEventSummary[] = [];
  for (const file of files) {
    if (!safeExistsSync(file)) continue;
    const raw = safeReadFile(file, { encoding: "utf8" }) as string;
    for (const line of raw.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as any;
        lines.push({
          ts: event.ts || new Date().toISOString(),
          decision: event.decision || event.event_type || "event",
          mission_id: event.mission_id || event.resource_id,
          why: event.why,
        });
      } catch {
        // Ignore malformed lines.
      }
    }
  }
  return lines
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 8);
}

export function collectControlActions(): ControlActionSummary[] {
  const file = pathResolver.shared("observability/mission-control/orchestration-events.jsonl");
  if (!safeExistsSync(file)) return [];

  const lifecycle = new Map<string, ControlActionSummary>();
  const raw = safeReadFile(file, { encoding: "utf8" }) as string;

  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as any;
      const decision = event.decision || event.event_type;
      const eventId = typeof event.event_id === "string" ? event.event_id : undefined;

      if (
        decision === "mission_orchestration_event_enqueued" &&
        (event.event_type === "mission_control_requested" || event.event_type === "surface_control_requested") &&
        eventId
      ) {
        const queuedTarget = event.event_type === "surface_control_requested"
          ? event.payload?.surfaceId || "surface-runtime"
          : event.mission_id || "system";
        lifecycle.set(eventId, {
          event_id: eventId,
          ts: event.ts || new Date().toISOString(),
          kind: event.event_type === "mission_control_requested" ? "mission" : "surface",
          target: queuedTarget,
          operation: typeof event.payload?.operation === "string" ? event.payload.operation : event.event_type,
          status: "queued",
          requested_by: event.requested_by || "unknown",
        });
        continue;
      }

      if (
        (decision === "mission_control_action_applied" || decision === "surface_control_action_applied") &&
        typeof event.operation === "string"
      ) {
        const syntheticId = `${decision}:${event.mission_id || event.resource_id || "system"}:${event.operation}:${event.ts || ""}`;
        lifecycle.set(syntheticId, {
          event_id: eventId,
          ts: event.ts || new Date().toISOString(),
          kind: decision === "mission_control_action_applied" ? "mission" : "surface",
          target: event.mission_id || event.resource_id || "system",
          operation: event.operation,
          status: "completed",
          requested_by: event.requested_by || "unknown",
        });
        continue;
      }

      if (
        decision === "mission_orchestration_event_failed" &&
        (event.event_type === "mission_control_requested" || event.event_type === "surface_control_requested") &&
        eventId
      ) {
        const failedTarget = event.event_type === "surface_control_requested"
          ? event.payload?.surfaceId || "surface-runtime"
          : event.mission_id || "system";
        lifecycle.set(eventId, {
          event_id: eventId,
          ts: event.ts || new Date().toISOString(),
          kind: event.event_type === "mission_control_requested" ? "mission" : "surface",
          target: failedTarget,
          operation: typeof event.payload?.operation === "string" ? event.payload.operation : event.event_type,
          status: "failed",
          requested_by: event.requested_by || "unknown",
          error: typeof event.error === "string" ? event.error : undefined,
        });
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  return Array.from(lifecycle.values())
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 10);
}

export function collectControlActionDetails(): Record<string, ControlActionDetail[]> {
  const file = pathResolver.shared("observability/mission-control/orchestration-events.jsonl");
  if (!safeExistsSync(file)) return {};

  const details: Record<string, ControlActionDetail[]> = {};
  const raw = safeReadFile(file, { encoding: "utf8" }) as string;

  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as any;
      const eventId = typeof event.event_id === "string" ? event.event_id : undefined;
      if (!eventId) continue;
      if (
        event.event_type !== "mission_control_requested" &&
        event.event_type !== "surface_control_requested" &&
        event.decision !== "mission_control_action_applied" &&
        event.decision !== "surface_control_action_applied" &&
        event.decision !== "mission_orchestration_event_started" &&
        event.decision !== "mission_orchestration_event_completed" &&
        event.decision !== "mission_orchestration_event_failed"
      ) {
        continue;
      }

      if (!details[eventId]) {
        details[eventId] = [];
      }
      details[eventId].push({
        ts: event.ts || new Date().toISOString(),
        decision: event.decision || "event",
        event_type: event.event_type,
        mission_id: event.mission_id,
        resource_id: event.resource_id,
        operation: event.operation,
        why: event.why,
        error: event.error,
      });
    } catch {
      // Ignore malformed lines.
    }
  }

  for (const key of Object.keys(details)) {
    details[key] = details[key]
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, 8);
  }

  return details;
}

export function collectOwnerSummaries(): OwnerSummary[] {
  const summaries: OwnerSummary[] = [];
  const files = [
    pathResolver.shared("observability/channels/slack/missions.jsonl"),
    pathResolver.shared("observability/mission-control/orchestration-events.jsonl"),
  ];

  for (const file of files) {
    if (!safeExistsSync(file)) continue;
    const raw = safeReadFile(file, { encoding: "utf8" }) as string;
    for (const line of raw.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as any;
        if ((event.decision || event.event_type) !== "mission_owner_notified") continue;
        summaries.push({
          ts: event.ts || new Date().toISOString(),
          mission_id: event.mission_id || "unknown",
          accepted_count: Number(event.accepted_count || 0),
          reviewed_count: Number(event.reviewed_count || 0),
          completed_count: Number(event.completed_count || 0),
          requested_count: Number(event.requested_count || 0),
        });
      } catch {
        // Ignore malformed lines.
      }
    }
  }
  return summaries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 6);
}

export function collectBrowserSessions(): BrowserSessionSummary[] {
  const sessionDir = pathResolver.shared("runtime/browser/sessions");
  if (!safeExistsSync(sessionDir)) return [];

  const sessions: BrowserSessionSummary[] = [];
  for (const entry of safeReaddir(sessionDir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = safeReadFile(pathResolver.shared(`runtime/browser/sessions/${entry}`), { encoding: "utf8" }) as string;
      const parsed = JSON.parse(raw) as BrowserSessionSummary;
      if (!parsed?.session_id) continue;
      sessions.push(parsed);
    } catch {
      // Ignore malformed session files.
    }
  }

  return sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12);
}

export function collectBrowserConversationSessions(): BrowserConversationSessionSummary[] {
  const sessionDir = pathResolver.shared("runtime/browser/conversation-sessions");
  if (!safeExistsSync(sessionDir)) return [];

  const sessions: BrowserConversationSessionSummary[] = [];
  for (const entry of safeReaddir(sessionDir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = safeReadFile(pathResolver.shared(`runtime/browser/conversation-sessions/${entry}`), { encoding: "utf8" }) as string;
      const parsed = JSON.parse(raw) as any;
      if (!parsed?.session_id) continue;
      sessions.push({
        session_id: parsed.session_id,
        surface: parsed.surface || "unknown",
        status: parsed.status || "unknown",
        mode: parsed.mode || "interactive",
        updated_at: parsed.updated_at || new Date(0).toISOString(),
        goal_summary: parsed.goal?.summary || "",
        active_step: parsed.active_step?.description,
        pending_confirmation: parsed.conversation_context?.pending_confirmation === true,
        candidate_target_count: Array.isArray(parsed.candidate_targets) ? parsed.candidate_targets.length : 0,
      });
    } catch {
      // Ignore malformed session files.
    }
  }

  return sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12);
}
