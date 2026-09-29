import {
  getReasoningBackend,
  hasRegisteredReasoningBackend,
} from '../reasoning/reasoning-backend.js';
import { DISCUSSION_ROLE_LABELS } from './discussion-team.js';
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
}

function roleLabel(role: string, locale: 'ja' | 'en'): string {
  return DISCUSSION_ROLE_LABELS[role]?.[locale] ?? role;
}

function clip(text: string, max = 40): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ---------------------------------------------------------------------------
// Scripted speaker — deterministic, offline. Drives demos and tests; the shape
// of the conversation (challenge → refine → converge) is the same one the live
// speaker is prompted toward.
// ---------------------------------------------------------------------------

type Script = { text: string; performative: DiscussionPerformative; stance: DiscussionStance };
type RoleScript = Array<
  { ja: (g: string) => string; en: (g: string) => string } & Omit<Script, 'text'>
>;

const SCRIPTS: Record<string, RoleScript> = {
  researcher: [
    {
      performative: 'inform',
      stance: 'neutral',
      ja: (g) =>
        `「${g}」に関して、まず事実を整理します。既存の運用資産と制約を洗い出すと、選択肢は3案に絞れます。定量的な根拠は次のラウンドで補強します。`,
      en: (g) =>
        `On "${g}": let me ground us in facts first. Surveying existing assets and constraints narrows this to three options; I'll back them with numbers next round.`,
    },
    {
      performative: 'inform',
      stance: 'support',
      ja: () =>
        `懸念点を踏まえて追加調査しました。段階導入案は過去事例でも失敗率が低く、ロールバック手段を先に用意すれば主要リスクは管理可能です。`,
      en: () =>
        `I dug into the concerns. Phased rollout shows a lower failure rate in comparable cases, and with a rollback path prepared first the main risks are manageable.`,
    },
    {
      performative: 'agree',
      stance: 'support',
      ja: () =>
        `提示された修正案は調査結果と整合しています。前提条件を明記すれば、根拠として十分だと判断します。`,
      en: () =>
        `The revised proposal is consistent with the evidence. With its assumptions written down, I consider the grounds sufficient.`,
    },
  ],
  planner: [
    {
      performative: 'propose',
      stance: 'support',
      ja: (g) =>
        `「${g}」の進め方として、①小さく試す → ②評価基準で判定 → ③展開、の3段階を提案します。各段階に完了条件とオーナーを置きます。`,
      en: (g) =>
        `For "${g}" I propose three stages: (1) pilot small, (2) judge against explicit criteria, (3) roll out. Each stage gets exit criteria and an owner.`,
    },
    {
      performative: 'propose',
      stance: 'support',
      ja: () =>
        `反対意見を取り込み、第1段階に「撤退条件」を追加します。撤退条件を満たさない場合は自動的に第2段階へ進まず、人間の判断を仰ぎます。`,
      en: () =>
        `Taking the objection on board, I'm adding an abort condition to stage 1: if it isn't met we don't advance automatically, we escalate to a human.`,
    },
    {
      performative: 'agree',
      stance: 'support',
      ja: () => `計画は合意可能な形になりました。担当と期限を割り当てて確定させたいです。`,
      en: () =>
        `The plan is in a shape we can agree on. Let's assign owners and dates and lock it in.`,
    },
  ],
  reviewer: [
    {
      performative: 'challenge',
      stance: 'question',
      ja: () =>
        `品質面で確認したい点があります。成功をどう測るのか、失敗時の影響範囲はどこまでか、が現時点では曖昧です。`,
      en: () =>
        `From a quality view, two things are unclear: how success is measured, and how far a failure would spread.`,
    },
    {
      performative: 'challenge',
      stance: 'neutral',
      ja: () =>
        `撤退条件の追加は前進です。ただし計測指標の閾値が未定です。数値を決めれば承認できます。`,
      en: () =>
        `The abort condition is progress, but the metric thresholds are still open. Once numbers are set I can approve.`,
    },
    {
      performative: 'agree',
      stance: 'support',
      ja: () => `指標と閾値が明記されたので、レビュー観点では承認します。`,
      en: () => `Metrics and thresholds are now explicit; from a review standpoint I approve.`,
    },
  ],
  devils_advocate: [
    {
      performative: 'challenge',
      stance: 'oppose',
      ja: (g) =>
        `あえて反対します。「${g}」は本当に今やるべきでしょうか。現状維持のコストを過小評価していないか、成功前提で話が進んでいないか、疑うべきです。`,
      en: (g) =>
        `Let me push back deliberately: should we do "${g}" now at all? Are we underestimating the cost of the status quo, and assuming success too readily?`,
    },
    {
      performative: 'challenge',
      stance: 'question',
      ja: () =>
        `段階導入と撤退条件は評価しますが、撤退条件を誰が判定するのかが未定です。判定者が推進側だと形骸化します。独立した判定者を置くべきです。`,
      en: () =>
        `Staging and an abort condition are good, but who judges the abort? If it's the proponents it becomes theatre. We need an independent judge.`,
    },
    {
      performative: 'agree',
      stance: 'support',
      ja: () =>
        `独立した判定者を置く条件付きで賛成に回ります。ただし反対意見として「想定外の外部要因」は残余リスクとして記録してください。`,
      en: () =>
        `I'll support on the condition of an independent judge. Please record "unforeseen external factors" as residual risk for the dissent log.`,
    },
  ],
  scribe: [
    {
      performative: 'inform',
      stance: 'neutral',
      ja: () =>
        `記録します。現時点の論点は「実施の要否」「進め方」「リスク管理」の3つです。発言はすべて議事に紐づけます。`,
      en: () =>
        `Noted. Open threads: whether to proceed, how to proceed, and risk control. Every statement is linked to the minutes.`,
    },
    {
      performative: 'inform',
      stance: 'neutral',
      ja: () =>
        `暫定合意: 段階導入、撤退条件の設定。未決: 判定者の独立性、指標の閾値。反対意見は分離して保存しています。`,
      en: () =>
        `Tentative agreements: staged rollout, an abort condition. Open: judge independence, metric thresholds. Dissent is stored separately.`,
    },
    {
      performative: 'summarize',
      stance: 'support',
      ja: () => `合意事項・残余リスク・次のアクションを整理しました。最終決定に反映できます。`,
      en: () =>
        `Agreements, residual risks and next actions are organized and ready for the final decision.`,
    },
  ],
};

const GENERIC_SCRIPT: RoleScript = [
  {
    performative: 'inform',
    stance: 'neutral',
    ja: (g) => `専門の立場から見ると、「${g}」は前提条件の確認が先決です。`,
    en: (g) => `From my specialty, "${g}" needs its preconditions verified first.`,
  },
  {
    performative: 'propose',
    stance: 'support',
    ja: () => `議論の内容を踏まえ、提案の方向性に賛成します。詳細は実行段階で詰めましょう。`,
    en: () => `Given the discussion I support the direction; details can be settled at execution.`,
  },
  {
    performative: 'agree',
    stance: 'support',
    ja: () => `合意内容で問題ありません。`,
    en: () => `No objection to the agreed content.`,
  },
];

export class ScriptedDiscussionSpeaker implements DiscussionSpeaker {
  readonly mode = 'scripted' as const;

  async speak(request: SpeakRequest): Promise<SpeakResult> {
    const { room, participant, intent } = request;
    const locale = room.config.locale;
    const goal = clip(room.goal);
    if (intent === 'respond_human') {
      const human = clip(request.humanPrompt ?? '', 60);
      return {
        performative: 'inform',
        stance: 'neutral',
        text:
          locale === 'ja'
            ? `ご指摘ありがとうございます。「${human}」を踏まえ、${roleLabel(participant.role, 'ja')}の立場で論点を見直します。`
            : `Thanks for the steer. Taking "${human}" into account, I'll revisit the points from my ${roleLabel(participant.role, 'en')} seat.`,
      };
    }
    if (participant.role === 'facilitator') {
      const agenda = request.agenda ? clip(request.agenda.title, 50) : goal;
      return {
        performative: 'propose',
        stance: 'neutral',
        text:
          locale === 'ja'
            ? `本日の目的は「${goal}」です。今回の論点は「${agenda}」。各自、立場を明確にして発言してください。まず ${roleLabel('researcher', 'ja')} から事実整理をお願いします。`
            : `Our goal: "${goal}". Current topic: "${agenda}". Please state your position clearly; let's start with the researcher's fact base.`,
      };
    }
    const script = SCRIPTS[participant.role] ?? GENERIC_SCRIPT;
    const own = room.message_counts[participant.id] ?? 0;
    const entry = script[Math.min(own, script.length - 1)];
    return {
      performative: entry.performative,
      stance: entry.stance,
      text: locale === 'ja' ? entry.ja(goal) : entry.en(goal),
    };
  }

  async summarize(request: SpeakRequest): Promise<SummaryResult> {
    const { room } = request;
    const ja = room.config.locale === 'ja';
    const round = room.round;
    const supporters = Object.entries(room.stance_by_speaker).filter(([, s]) => s === 'support');
    const dissenters = Object.entries(room.stance_by_speaker).filter(
      ([, s]) => s === 'oppose' || s === 'question'
    );
    const open_issues = dissenters.map(([speakerId, stance]) =>
      ja
        ? `${roleLabel(speakerId, 'ja')}: ${stance === 'oppose' ? '反対意見が未解消' : '確認事項が未解消'}`
        : `${roleLabel(speakerId, 'en')}: ${stance === 'oppose' ? 'objection unresolved' : 'question unresolved'}`
    );
    const agreements = supporters.map(([speakerId]) =>
      ja
        ? `${roleLabel(speakerId, 'ja')}が方向性を支持`
        : `${roleLabel(speakerId, 'en')} backs the direction`
    );
    return {
      summary: ja
        ? `第${round}ラウンド: 支持${supporters.length}、要確認・反対${dissenters.length}。${
            dissenters.length
              ? '未解消の論点を次ラウンドで詰めます。'
              : '全員の立場が揃いました。決定に進めます。'
          }`
        : `Round ${round}: ${supporters.length} supporting, ${dissenters.length} open. ${
            dissenters.length
              ? 'Unresolved points go to the next round.'
              : 'Everyone is aligned; ready to decide.'
          }`,
      open_issues,
      agreements,
    };
  }

  async conclude(request: SpeakRequest): Promise<DecisionDraft> {
    const { room } = request;
    const ja = room.config.locale === 'ja';
    const dissent = room.messages
      .filter((m) => m.kind === 'agent' && (m.stance === 'oppose' || m.stance === 'question'))
      .slice(-3)
      .map((m) => `${roleLabel(m.speaker, room.config.locale)}: ${clip(m.text, 70)}`);
    return {
      summary: ja
        ? `「${clip(room.goal, 50)}」について、段階導入を前提に進めることで合意しました。撤退条件と独立した判定者を置くことが条件です。`
        : `On "${clip(room.goal, 50)}", the team agreed to proceed on a staged basis, conditional on an abort criterion and an independent judge.`,
      agreements: room.agreements.length
        ? room.agreements
        : [ja ? '段階導入で進める' : 'Proceed in stages'],
      dissent,
      next_steps: ja
        ? [
            'パイロットの範囲とオーナーを確定する',
            '撤退条件と指標の閾値を文書化する',
            '独立した判定者を任命する',
          ]
        : [
            'Fix pilot scope and owner',
            'Document abort criteria and metric thresholds',
            'Appoint an independent judge',
          ],
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

function extractJson(raw: string): Record<string, unknown> | null {
  const match = raw.match(/\{[\s\S]*\}/u);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
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
