import {
  getReasoningBackend,
  hasRegisteredReasoningBackend,
} from '../reasoning/reasoning-backend.js';
import { discussionRoleLabel, fillCopy, loadDiscussionCopy } from './discussion-copy.js';
import type {
  DiscussionAgendaItem,
  DiscussionParticipant,
  DiscussionPerformative,
  DiscussionRoomState,
  DiscussionStance,
} from './discussion-types.js';

export type SpeakIntent = 'frame' | 'contribute' | 'respond_human' | 'summarize' | 'conclude';

export interface SpeakRequest {
  room: DiscussionRoomState;
  participant: DiscussionParticipant;
  intent: SpeakIntent;
  agenda?: DiscussionAgendaItem;
  /** Human message the participant is answering (respond_human). */
  humanPrompt?: string;
}

export interface SpeakResult {
  text: string;
  performative: DiscussionPerformative;
  stance: DiscussionStance;
  mentions?: string[];
}

export interface SummaryResult {
  summary: string;
  open_issues: string[];
  agreements: string[];
}

export interface DecisionDraft {
  summary: string;
  agreements: string[];
  dissent: string[];
  next_steps: string[];
}

/** The seam between the facilitator engine and whatever produces utterances. */
export interface DiscussionSpeaker {
  readonly mode: 'scripted' | 'reasoning';
  speak(request: SpeakRequest): Promise<SpeakResult>;
  summarize(request: SpeakRequest): Promise<SummaryResult>;
  conclude(request: SpeakRequest): Promise<DecisionDraft>;
  /** Optional: pick discretionary team seats for a goal (live speakers only). */
  proposeRoles?(goal: string, candidates: string[], locale: 'ja' | 'en'): Promise<string[]>;
}

function roleLabel(role: string, locale: 'ja' | 'en'): string {
  return discussionRoleLabel(role, locale);
}

function clip(text: string, max = 40): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ---------------------------------------------------------------------------
// Scripted speaker — deterministic, offline. Drives demos and tests; the shape
// of the conversation (challenge → refine → converge) is the same one the live
// speaker is prompted toward. All prose comes from discussion-copy.json.
// ---------------------------------------------------------------------------

export class ScriptedDiscussionSpeaker implements DiscussionSpeaker {
  readonly mode = 'scripted' as const;

  async speak(request: SpeakRequest): Promise<SpeakResult> {
    const { room, participant, intent } = request;
    const locale = room.config.locale;
    const copy = loadDiscussionCopy();
    const goal = clip(room.goal);
    if (intent === 'respond_human') {
      return {
        performative: 'inform',
        stance: 'neutral',
        text: fillCopy(copy.respond_human[locale], {
          human: clip(request.humanPrompt ?? '', 60),
          role: roleLabel(participant.role, locale),
        }),
      };
    }
    if (participant.role === 'facilitator') {
      return {
        performative: 'propose',
        stance: 'neutral',
        text: fillCopy(copy.facilitator_frame[locale], {
          goal,
          agenda: request.agenda ? clip(request.agenda.title, 50) : goal,
          researcher: roleLabel('researcher', locale),
        }),
      };
    }
    const script = copy.scripts[participant.role] ?? copy.generic_script;
    const own = room.message_counts[participant.id] ?? 0;
    const entry = script[Math.min(own, script.length - 1)];
    return {
      performative: entry.performative,
      stance: entry.stance,
      text: fillCopy(entry[locale], { goal }),
    };
  }

  async summarize(request: SpeakRequest): Promise<SummaryResult> {
    const { room } = request;
    const locale = room.config.locale;
    const { summary } = loadDiscussionCopy();
    const supporters = Object.entries(room.stance_by_speaker).filter(([, s]) => s === 'support');
    const dissenters = Object.entries(room.stance_by_speaker).filter(
      ([, s]) => s === 'oppose' || s === 'question'
    );
    const open_issues = dissenters.map(([speakerId, stance]) =>
      fillCopy((stance === 'oppose' ? summary.issue_oppose : summary.issue_question)[locale], {
        role: roleLabel(speakerId, locale),
      })
    );
    const agreements = supporters.map(([speakerId]) =>
      fillCopy(summary.agreement[locale], { role: roleLabel(speakerId, locale) })
    );
    return {
      summary: fillCopy(summary.text[locale], {
        round: room.round,
        supporting: supporters.length,
        open: dissenters.length,
        tail: (dissenters.length ? summary.tail_open : summary.tail_done)[locale],
      }),
      open_issues,
      agreements,
    };
  }

  async conclude(request: SpeakRequest): Promise<DecisionDraft> {
    const { room } = request;
    const locale = room.config.locale;
    const { decision } = loadDiscussionCopy();
    const dissent = room.messages
      .filter((m) => m.kind === 'agent' && (m.stance === 'oppose' || m.stance === 'question'))
      .slice(-3)
      .map((m) => `${roleLabel(m.speaker, locale)}: ${clip(m.text, 70)}`);
    return {
      summary: fillCopy(decision.summary[locale], { goal: clip(room.goal, 50) }),
      agreements: room.agreements.length ? room.agreements : [decision.default_agreement[locale]],
      dissent,
      next_steps: decision.next_steps[locale],
    };
  }
}

// ---------------------------------------------------------------------------
// Reasoning speaker — each utterance is one delegated call to the registered
// reasoning backend, prompted with the role charter and the recent transcript.
// ---------------------------------------------------------------------------

const ROLE_CHARTERS: Record<string, string> = {
  facilitator:
    'You run the discussion: frame the topic, keep people on the goal, name unresolved points, never take sides yourself.',
  researcher: 'You bring evidence, compare options and state uncertainty honestly.',
  devils_advocate:
    'You argue the opposite position to expose weak assumptions. Concede only when a real answer is given.',
  scribe: 'You record agreements, open points and dissent precisely and neutrally.',
  planner: 'You turn the discussion into a concrete staged plan with owners and exit criteria.',
  reviewer: 'You judge quality and risk and state what would make you approve.',
};

function transcript(room: DiscussionRoomState, limit = 14): string {
  return room.messages
    .slice(-limit)
    .map((m) => `[${m.kind === 'human' ? 'HUMAN' : roleLabel(m.speaker, 'en')}] ${m.text}`)
    .join('\n');
}

/**
 * Pull the outermost JSON object out of free-form model output. Uses index
 * scans instead of a backtracking pattern so adversarial output (thousands of
 * `{`) stays linear.
 */
export function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const PERFORMATIVES: DiscussionPerformative[] = [
  'inform',
  'propose',
  'challenge',
  'agree',
  'summarize',
];
const STANCES: DiscussionStance[] = ['support', 'oppose', 'neutral', 'question'];

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export class ReasoningDiscussionSpeaker implements DiscussionSpeaker {
  readonly mode = 'reasoning' as const;
  private readonly fallback = new ScriptedDiscussionSpeaker();

  private language(room: DiscussionRoomState): string {
    return room.config.locale === 'ja' ? 'Japanese' : 'English';
  }

  private async ask(instruction: string, context: string): Promise<string> {
    return getReasoningBackend().delegateTask(instruction, context);
  }

  async speak(request: SpeakRequest): Promise<SpeakResult> {
    const { room, participant, intent } = request;
    const charter = ROLE_CHARTERS[participant.role] ?? 'You contribute your specialty to the goal.';
    const instruction = [
      `You are "${participant.name}", seated as ${roleLabel(participant.role, 'en')} in a facilitated multi-agent discussion.`,
      charter,
      `Goal: ${room.goal}`,
      request.agenda ? `Current topic: ${request.agenda.title}` : '',
      intent === 'respond_human'
        ? `A human operator just said: "${request.humanPrompt}". Respond to it directly.`
        : intent === 'frame'
          ? 'Open the discussion: state the goal, the topic, and how you want people to contribute.'
          : 'Make your next contribution. React to what others said; do not repeat yourself.',
      `Reply in ${this.language(room)}, at most 3 sentences.`,
      'Return ONLY JSON: {"text": string, "performative": "inform|propose|challenge|agree|summarize", "stance": "support|oppose|neutral|question"}',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const raw = await this.ask(instruction, transcript(room));
      const json = extractJson(raw);
      const text = typeof json?.text === 'string' ? json.text.trim() : raw.trim();
      if (!text) throw new Error('empty utterance');
      return {
        text: text.slice(0, 1200),
        performative: PERFORMATIVES.includes(json?.performative as DiscussionPerformative)
          ? (json?.performative as DiscussionPerformative)
          : 'inform',
        stance: STANCES.includes(json?.stance as DiscussionStance)
          ? (json?.stance as DiscussionStance)
          : 'neutral',
      };
    } catch {
      return this.fallback.speak(request);
    }
  }

  async proposeRoles(goal: string, candidates: string[]): Promise<string[]> {
    const instruction = [
      "You staff a facilitated multi-agent discussion. A facilitator, researcher, devil's advocate and scribe are always seated.",
      `Goal: ${goal}`,
      `Pick 1 to 2 additional seats that this goal really needs, only from: ${candidates.join(', ')}.`,
      'Return ONLY JSON: {"roles": string[]}',
    ].join('\n');
    try {
      const json = extractJson(await this.ask(instruction, ''));
      return asStringArray(json?.roles)
        .filter((role) => candidates.includes(role))
        .slice(0, 2);
    } catch {
      return [];
    }
  }

  async summarize(request: SpeakRequest): Promise<SummaryResult> {
    const { room } = request;
    const instruction = [
      'You are the facilitator. Summarize this round of the discussion.',
      `Goal: ${room.goal}`,
      `Reply in ${this.language(room)}.`,
      'Return ONLY JSON: {"summary": string, "open_issues": string[], "agreements": string[]}',
    ].join('\n');
    try {
      const json = extractJson(await this.ask(instruction, transcript(room, 24)));
      if (typeof json?.summary !== 'string') throw new Error('no summary');
      return {
        summary: json.summary,
        open_issues: asStringArray(json.open_issues).slice(0, 6),
        agreements: asStringArray(json.agreements).slice(0, 6),
      };
    } catch {
      return this.fallback.summarize(request);
    }
  }

  async conclude(request: SpeakRequest): Promise<DecisionDraft> {
    const { room } = request;
    const instruction = [
      'You are the facilitator. Produce the final decision record for this discussion.',
      `Goal: ${room.goal}`,
      `Reply in ${this.language(room)}.`,
      'Return ONLY JSON: {"summary": string, "agreements": string[], "dissent": string[], "next_steps": string[]}',
    ].join('\n');
    try {
      const json = extractJson(await this.ask(instruction, transcript(room, 30)));
      if (typeof json?.summary !== 'string') throw new Error('no decision');
      return {
        summary: json.summary,
        agreements: asStringArray(json.agreements).slice(0, 8),
        dissent: asStringArray(json.dissent).slice(0, 8),
        next_steps: asStringArray(json.next_steps).slice(0, 8),
      };
    } catch {
      return this.fallback.conclude(request);
    }
  }
}

export function resolveDiscussionSpeaker(
  preference: 'auto' | 'scripted' | 'reasoning'
): DiscussionSpeaker {
  if (preference === 'scripted') return new ScriptedDiscussionSpeaker();
  if (preference === 'reasoning') return new ReasoningDiscussionSpeaker();
  return hasRegisteredReasoningBackend()
    ? new ReasoningDiscussionSpeaker()
    : new ScriptedDiscussionSpeaker();
}
