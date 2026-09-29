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

export interface DialogueAttachmentContext {
  name: string;
  status: 'read' | 'stored';
  excerpt?: string;
}

export interface DialogueTurnRequest {
  room: DiscussionRoomState;
  facilitator: DiscussionParticipant;
  human: { id: string; text: string; attachments: DialogueAttachmentContext[] };
  /** The person asked for another answer to the same message. */
  retry: boolean;
}

export interface DialogueGoalPatch {
  objective?: string;
  add_success_criteria?: string[];
  add_constraints?: string[];
  add_assumptions?: string[];
  add_decisions?: string[];
}

export interface DialogueReply {
  text: string;
  suggestions: string[];
  goal_patch: DialogueGoalPatch;
  resolve: Array<{ id: string; answer?: string }>;
  new_questions: Array<{ id: string; text: string; blocking: boolean }>;
  /** Team roles the facilitator wants to hear from before the next question. */
  consult: string[];
}

export interface DialogueHooks {
  /** Report the reply so far (streaming). */
  onText(textSoFar: string): void;
  shouldStop(): boolean;
  /** Pace streaming; a no-op in tests. */
  delay(ms: number): Promise<void>;
}

/** The seam between the facilitator engine and whatever produces utterances. */
export interface DiscussionSpeaker {
  readonly mode: 'scripted' | 'reasoning';
  speak(request: SpeakRequest): Promise<SpeakResult>;
  summarize(request: SpeakRequest): Promise<SummaryResult>;
  conclude(request: SpeakRequest): Promise<DecisionDraft>;
  /** Dialogue mode: the facilitator's opening message and first questions. */
  dialogueOpen?(
    room: DiscussionRoomState,
    facilitator: DiscussionParticipant
  ): Promise<DialogueReply>;
  /** Dialogue mode: answer one human message, updating the goal as it takes shape. */
  dialogueTurn?(request: DialogueTurnRequest, hooks: DialogueHooks): Promise<DialogueReply>;
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

  // ---- dialogue mode (deterministic, offline) -------------------------------

  private slotOrder(): string[] {
    return Object.keys(loadDiscussionCopy().dialogue.questions);
  }

  private questionReply(
    room: DiscussionRoomState,
    text: string,
    goal_patch: DialogueGoalPatch,
    resolve: DialogueReply['resolve'],
    newQuestions: DialogueReply['new_questions'] = []
  ): DialogueReply {
    const locale = room.config.locale;
    const { questions } = loadDiscussionCopy().dialogue;
    const resolvedNow = new Set(resolve.map((r) => r.id));
    const nextOpen = this.slotOrder().find((id) => {
      const known = room.dialogue.questions.find((q) => q.id === id);
      const isOpen = known ? known.status === 'open' : true;
      return isOpen && !resolvedNow.has(id);
    });
    return {
      text,
      suggestions: nextOpen ? questions[nextOpen].suggestions[locale] : [],
      goal_patch,
      resolve,
      new_questions: newQuestions,
      consult: [],
    };
  }

  async dialogueOpen(
    room: DiscussionRoomState,
    _facilitator: DiscussionParticipant
  ): Promise<DialogueReply> {
    const locale = room.config.locale;
    const { dialogue } = loadDiscussionCopy();
    const order = this.slotOrder();
    const first = dialogue.questions[order[0]];
    const text = fillCopy(dialogue.opening[locale], {
      objective: clip(room.goal, 80),
      question: first.text[locale],
    });
    return {
      text,
      suggestions: first.suggestions[locale],
      goal_patch: { objective: clip(room.goal, 200) },
      resolve: [],
      new_questions: order.map((id) => ({
        id,
        text: dialogue.questions[id].text[locale],
        blocking: true,
      })),
      consult: [],
    };
  }

  async dialogueTurn(request: DialogueTurnRequest, hooks: DialogueHooks): Promise<DialogueReply> {
    const { room, human } = request;
    const locale = room.config.locale;
    const { dialogue } = loadDiscussionCopy();
    const answer = clip(human.text, 300);
    const parts: string[] = [];
    for (const attachment of human.attachments) {
      parts.push(
        fillCopy(
          (attachment.status === 'read' ? dialogue.attachment_read : dialogue.attachment_stored)[
            locale
          ],
          { name: attachment.name }
        )
      );
    }

    // The first still-open scripted question is the one this message answers.
    const slot = this.slotOrder().find(
      (id) => room.dialogue.questions.find((q) => q.id === id)?.status !== 'resolved'
    );
    let reply: DialogueReply;
    if (slot) {
      const label = dialogue.questions[slot].label[locale];
      const patch: DialogueGoalPatch =
        slot === 'q-criteria'
          ? { add_success_criteria: [answer] }
          : slot === 'q-constraints'
            ? { add_constraints: [answer] }
            : { add_decisions: [slot === 'q-first-step' ? `${label}: ${answer}` : answer] };
      const after = this.slotOrder().find(
        (id) =>
          id !== slot && room.dialogue.questions.find((q) => q.id === id)?.status !== 'resolved'
      );
      parts.push(fillCopy(dialogue.ack[locale], { label, answer }));
      if (after) {
        parts.push(
          fillCopy(dialogue.next[locale], { question: dialogue.questions[after].text[locale] })
        );
      } else {
        parts.push(dialogue.ready[locale]);
      }
      reply = this.questionReply(room, parts.join('\n\n'), patch, [{ id: slot, answer }]);
    } else {
      // Everything scripted is settled; fold further input in as an assumption.
      parts.push(fillCopy(dialogue.freeform[locale], { answer }), dialogue.ready[locale]);
      reply = this.questionReply(room, parts.join('\n\n'), { add_assumptions: [answer] }, []);
    }

    // Stream it out in small chunks so the surface can show it arriving.
    const chunk = 6;
    for (let end = chunk; end < reply.text.length + chunk; end += chunk) {
      if (hooks.shouldStop()) return reply;
      hooks.onText(reply.text.slice(0, end));
      await hooks.delay(28);
    }
    return reply;
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
    if (room.config.mode === 'dialogue') {
      const dialogue = loadDiscussionCopy().dialogue;
      const goal = room.dialogue;
      return {
        summary: fillCopy(dialogue.decision.summary[locale], {
          objective: clip(goal.objective || room.goal, 80),
        }),
        agreements: [...goal.success_criteria, ...goal.decisions],
        dissent: goal.questions
          .filter((q) => q.status === 'open')
          .map((q) => fillCopy(dialogue.decision.open_dissent[locale], { question: q.text })),
        next_steps: dialogue.decision.next_steps[locale],
      };
    }
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

const DIALOGUE_MARKER = '===JSON===';

/** Split a streamed dialogue answer into the visible reply and its trailing JSON control block. */
export function splitDialogueStream(raw: string): { text: string; json: string | null } {
  const at = raw.indexOf(DIALOGUE_MARKER);
  const visible = (at < 0 ? raw : raw.slice(0, at)).replace(/^\s*REPLY:\s*/u, '');
  return { text: visible.trimEnd(), json: at < 0 ? null : raw.slice(at + DIALOGUE_MARKER.length) };
}

function stringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim().slice(0, 300))
        .slice(0, limit)
    : [];
}

/** Turn the model's control block into a validated reply; anything malformed is dropped, never trusted. */
export function parseDialogueReply(
  raw: string,
  known: { questionIds: string[]; roles: string[] }
): DialogueReply | null {
  const { text, json } = splitDialogueStream(raw);
  if (!text.trim()) return null;
  const control = json ? extractJson(json) : null;
  const patch = (control?.goal_patch ?? {}) as Record<string, unknown>;
  const resolve = Array.isArray(control?.resolve)
    ? (control?.resolve as unknown[]).flatMap((item) => {
        const entry = item as { id?: unknown; answer?: unknown } | string;
        const id = typeof entry === 'string' ? entry : entry?.id;
        if (typeof id !== 'string' || !known.questionIds.includes(id)) return [];
        return [
          {
            id,
            ...(typeof entry !== 'string' && typeof entry.answer === 'string'
              ? { answer: entry.answer.slice(0, 300) }
              : {}),
          },
        ];
      })
    : [];
  const newQuestions = Array.isArray(control?.new_questions)
    ? (control?.new_questions as unknown[]).slice(0, 4).flatMap((item, index) => {
        const q = item as { text?: unknown; blocking?: unknown } | string;
        const questionText = typeof q === 'string' ? q : q?.text;
        if (typeof questionText !== 'string' || !questionText.trim()) return [];
        return [
          {
            id: `q-${Date.now().toString(36)}-${index}`,
            text: questionText.trim().slice(0, 240),
            blocking: typeof q === 'string' ? true : q.blocking !== false,
          },
        ];
      })
    : [];
  return {
    text: text.trim().slice(0, 4000),
    suggestions: stringList(control?.suggestions, 4),
    goal_patch: {
      ...(typeof patch.objective === 'string' && patch.objective.trim()
        ? { objective: patch.objective.trim().slice(0, 200) }
        : {}),
      add_success_criteria: stringList(patch.add_success_criteria, 5),
      add_constraints: stringList(patch.add_constraints, 5),
      add_assumptions: stringList(patch.add_assumptions, 5),
      add_decisions: stringList(patch.add_decisions, 5),
    },
    resolve,
    new_questions: newQuestions,
    consult: stringList(control?.consult, 2).filter((role) => known.roles.includes(role)),
  };
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

  // ---- dialogue mode -------------------------------------------------------

  private dialoguePrompt(request: DialogueTurnRequest | null, room: DiscussionRoomState): string {
    const goal = room.dialogue;
    const roles = room.participants
      .filter((p) => p.role !== 'facilitator' && p.role !== 'scribe')
      .map((p) => p.role);
    return [
      `You are the facilitator of a goal-driven conversation with one human. Reply in ${this.language(room)}.`,
      'Ask ONE clear question at a time, in at most 120 words. Markdown is allowed. Never invent what the human did not say.',
      'Record only what the human actually stated. Raise a blocking question only if the brief cannot be drafted without it.',
      `Consult a teammate only when their view would help now; allowed roles: ${roles.join(', ') || 'none'}.`,
      `Current goal state: ${JSON.stringify({
        objective: goal.objective,
        success_criteria: goal.success_criteria,
        constraints: goal.constraints,
        assumptions: goal.assumptions,
        decisions: goal.decisions,
        open_questions: goal.questions
          .filter((q) => q.status === 'open')
          .map((q) => ({ id: q.id, text: q.text })),
      })}`,
      request?.retry ? 'The human asked for a different answer: vary your wording and angle.' : '',
      ...(request?.human.attachments ?? []).map(
        (a) =>
          `Attachment "${a.name}" (${a.status}): ${a.excerpt ? a.excerpt.slice(0, 1500) : '(contents not readable)'}`
      ),
      'Output format — first the reply text for the human, then a line containing exactly ===JSON=== and then JSON only:',
      '{"goal_patch":{"objective":string?,"add_success_criteria":string[],"add_constraints":string[],"add_assumptions":string[],"add_decisions":string[]},"resolve":[{"id":string,"answer":string}],"new_questions":[{"text":string,"blocking":boolean}],"suggestions":string[],"consult":string[]}',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async runDialogueModel(
    instruction: string,
    context: string,
    room: DiscussionRoomState,
    hooks: DialogueHooks
  ): Promise<DialogueReply | null> {
    const known = {
      questionIds: room.dialogue.questions.map((q) => q.id),
      roles: room.participants.map((p) => p.role),
    };
    const backend = getReasoningBackend();
    let raw = '';
    if (typeof backend.streamPrompt === 'function') {
      for await (const piece of backend.streamPrompt(`${instruction}\n\n${context}`)) {
        if (hooks.shouldStop()) break;
        raw += piece;
        hooks.onText(splitDialogueStream(raw).text);
      }
    } else {
      raw = await backend.delegateTask(instruction, context);
      hooks.onText(splitDialogueStream(raw).text);
    }
    return parseDialogueReply(raw, known);
  }

  async dialogueOpen(
    room: DiscussionRoomState,
    facilitator: DiscussionParticipant
  ): Promise<DialogueReply> {
    const noop: DialogueHooks = {
      onText: () => undefined,
      shouldStop: () => false,
      delay: async () => undefined,
    };
    try {
      const reply = await this.runDialogueModel(
        `${this.dialoguePrompt(null, room)}\nThis is your opening message: greet, restate the objective, and ask the first question.`,
        `Objective: ${room.goal}`,
        room,
        noop
      );
      if (reply) {
        return {
          ...reply,
          goal_patch: {
            ...reply.goal_patch,
            objective: reply.goal_patch.objective ?? clip(room.goal, 200),
          },
        };
      }
    } catch {
      /* fall through to the scripted opening */
    }
    return this.fallback.dialogueOpen(room, facilitator);
  }

  async dialogueTurn(request: DialogueTurnRequest, hooks: DialogueHooks): Promise<DialogueReply> {
    const { room } = request;
    try {
      const reply = await this.runDialogueModel(
        this.dialoguePrompt(request, room),
        `${transcript(room, 16)}\n[HUMAN] ${request.human.text}`,
        room,
        hooks
      );
      if (reply) return reply;
    } catch {
      /* fall through to the scripted facilitator */
    }
    return this.fallback.dialogueTurn(request, hooks);
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
      const goalContext =
        room.config.mode === 'dialogue' ? `\nGoal state: ${JSON.stringify(room.dialogue)}` : '';
      const json = extractJson(await this.ask(instruction, transcript(room, 30) + goalContext));
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
