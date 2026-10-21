// AU-03: the hearing flow as an A2UI component (A2UI COMPONENT HOST PLAN §2.4).
//
// Pure projection: a hearing record (plus the phase progress and next
// question the route already resolves) becomes A2UI messages the host
// renders with its fixed component library, plus the *action descriptors*
// the host may execute. Every action is a reference to an existing headless
// operation (method + path) — this module never performs it, never knows the
// tenant, and never emits HTML. Labels arrive already resolved to the request
// locale (the route owns vocabulary resolution), so the projection is a
// deterministic function of its input.
import { validateA2UIMessage, type A2UIComponent, type A2UIMessage } from '@agent/core/a2ui';
import type { HearingRecord } from './hearing.js';

export const HEARING_A2UI_SURFACE_ID = 'flow:hearing';

/** An operation the host may invoke on the user's behalf. Mirrors a headless operation descriptor. */
export interface FlowActionDescriptor {
  operation_id: string;
  method: 'GET' | 'POST';
  path: string;
  /** Static body merged into the request (the host adds the input text for `input` actions). */
  body?: Record<string, unknown>;
  /** Re-fetch the projection after the action completes. */
  refresh?: boolean;
}

export interface HearingA2UIPhase {
  id: string;
  title: string;
  complete: number;
  total: number;
}

export interface HearingA2UIInput {
  record: HearingRecord;
  sessionId: string;
  /** Requirement labels already resolved to the request locale, by requirement id. */
  labels: Record<string, string>;
  phases: HearingA2UIPhase[];
  /** Companion's next prompt (or the "all answered" sentence). */
  prompt: string;
  nextRequirementId?: string;
  /** Chrome text, resolved by the route. */
  text: {
    title: string;
    coverage: string;
    next_question: string;
    unanswered: string;
    decide: string;
    handoff: string;
    phases: string;
    recorded?: string;
    handed_off?: string;
  };
  missionId?: string;
}

export interface HearingA2UIProjection {
  messages: A2UIMessage[];
  actions: FlowActionDescriptor[];
}

function component(
  id: string,
  type: A2UIComponent['type'],
  props: Record<string, unknown>
): A2UIComponent {
  return { id, type, props };
}

export function buildHearingA2UI(input: HearingA2UIInput): HearingA2UIProjection {
  const { record, sessionId, labels, phases, text } = input;
  const answered = record.requirements.filter((item) => item.answer?.trim()).length;
  const total = record.requirements.length;
  const allAnswered = total > 0 && answered === total;
  const decided = Boolean(record.decided_at);
  const encodedSession = encodeURIComponent(sessionId);
  const components: A2UIComponent[] = [];

  components.push(
    component('hearing-hero', 'display:hero', {
      title: text.title,
      subtitle: text.coverage,
    })
  );

  if (phases.length) {
    components.push(
      component('hearing-phases', 'display:progress', {
        title: text.phases,
        steps: phases.map((phase) => ({
          label: `${phase.title} ${phase.complete}/${phase.total}`,
          status:
            phase.complete >= phase.total
              ? 'done'
              : phase.id === currentPhaseId(phases)
                ? 'active'
                : 'pending',
        })),
      })
    );
  }

  if (decided) {
    components.push(
      component('hearing-decided', 'display:alert', {
        severity: 'success',
        title: text.recorded ?? text.decide,
        message: input.missionId && text.handed_off ? text.handed_off : '',
      })
    );
  } else {
    components.push(
      component('hearing-next', 'display:alert', {
        severity: 'info',
        title: text.next_question,
        message: input.prompt,
      })
    );
  }

  const byPhase = new Map<string, HearingRecord['requirements']>();
  for (const item of record.requirements) {
    const key = item.phase_id ?? '';
    byPhase.set(key, [...(byPhase.get(key) ?? []), item]);
  }
  const phaseOrder = phases.length ? phases.map((phase) => phase.id) : [...byPhase.keys()];
  for (const phaseId of phaseOrder) {
    const items = byPhase.get(phaseId) ?? [];
    if (!items.length) continue;
    const phase = phases.find((candidate) => candidate.id === phaseId);
    components.push(
      component(`hearing-phase-${phaseId || 'all'}`, 'display:section', {
        title: phase ? `${phase.title} (${phase.complete}/${phase.total})` : text.title,
        items: [
          {
            type: 'display:kv',
            props: {
              entries: items.map((item) => ({
                key: labels[item.id] ?? item.id,
                value: item.answer?.trim() ? item.answer.trim() : text.unanswered,
                ...(item.id === input.nextRequirementId ? { highlight: true } : {}),
              })),
            },
          },
        ],
      })
    );
  }

  const actions: FlowActionDescriptor[] = [];
  if (allAnswered && !decided) {
    const action: FlowActionDescriptor = {
      operation_id: 'presence.hearing.decide',
      method: 'POST',
      path: `/api/hearing/${encodedSession}/decide`,
      refresh: true,
    };
    actions.push(action);
    components.push(
      component('hearing-decide', 'button', { label: text.decide, variant: 'primary', action })
    );
  }
  if (decided && !input.missionId) {
    const action: FlowActionDescriptor = {
      operation_id: 'presence.hearing.handoff',
      method: 'POST',
      path: `/api/hearing/${encodedSession}/handoff`,
      refresh: true,
    };
    actions.push(action);
    components.push(
      component('hearing-handoff', 'button', { label: text.handoff, variant: 'primary', action })
    );
  }

  const messages: A2UIMessage[] = [
    {
      createSurface: {
        surfaceId: HEARING_A2UI_SURFACE_ID,
        catalogId: 'front-desk',
        title: text.title,
      },
    },
    { updateComponents: { surfaceId: HEARING_A2UI_SURFACE_ID, components } },
    {
      updateDataModel: {
        surfaceId: HEARING_A2UI_SURFACE_ID,
        data: {
          session_id: sessionId,
          answered,
          total,
          decided,
          ...(input.missionId ? { mission_id: input.missionId } : {}),
        },
      },
    },
  ];
  // The wire contract is validated at the seam, so a projection bug fails
  // here (server log) instead of as a blank host page.
  for (const message of messages) validateA2UIMessage(message);
  return { messages, actions };
}

function currentPhaseId(phases: HearingA2UIPhase[]): string | undefined {
  return phases.find((phase) => phase.complete < phase.total)?.id;
}
