/**
 * View-ready, serialisable data the worker posts to the render thread.
 * Everything here is plain data (structured-clone safe): no functions, no
 * class instances. Labels are already plain language; raw ids are kept only
 * for selection identity and for the governed commands an action needs.
 */

export type Lane = 'decide' | 'review' | 'blocked' | 'running' | 'done';

export const LANE_ORDER: readonly Lane[] = ['decide', 'review', 'blocked', 'running', 'done'];

export type Phase = 'intent' | 'agreed' | 'executing' | 'review' | 'learning' | 'done';

export const PHASE_ORDER: readonly Phase[] = [
  'intent',
  'agreed',
  'executing',
  'review',
  'learning',
  'done',
];

/** herdr agent states (`herdr agent wait --help`). */
export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface DeckMissionRow {
  id: string;
  /** Raw lifecycle status from the mission read model. */
  status: string;
  tier: string;
  tenantSlug?: string;
  goal?: string;
  successCondition?: string;
  missionType?: string;
  updatedAt?: string;
  lastEvent?: string;
  checkpoints: number;
  artifactCount: number;
}

export interface DecisionItem {
  /** Approval request id — the identity passed to the governed approvals CLI. */
  id: string;
  title: string;
  question: string;
  recommendation?: string;
  reasons: string[];
  ifNoResponse: string;
  reversible: boolean;
  level: 'decide' | 'veto' | 'fyi' | 'none';
  requestedBy?: string;
  requestedAt?: string;
  missionId?: string;
  /** Pre-rendered governed card lines (`renderDecisionCardLines`). */
  cardLines: string[];
}

export interface AgentTile {
  /** herdr agent target (name or pane id). */
  target: string;
  name: string;
  provider?: string;
  state: AgentState;
  /** Mission this agent works for, when the collaboration tree links it. */
  missionId?: string;
  /** Last output lines (sanitised at render time). */
  tail: string[];
}

export interface TaskProgress {
  id: string;
  title: string;
  status: string;
  deliverable?: string;
  deliverablePresent?: boolean;
}

export interface MissionDetail {
  id: string;
  phase: Phase;
  goal?: string;
  successCondition?: string;
  nextAction?: string;
  tasks: TaskProgress[];
  evidence: string[];
  history: { at?: string; event: string; note?: string }[];
  /** Label ids map to `deck:context_<label>` vocabulary. */
  context: { label: 'tier' | 'tenant' | 'type' | 'owner'; value: string }[];
}

export interface SourceHealth {
  source: string;
  ok: boolean;
  detail?: string;
}

export interface DeckSnapshot {
  generatedAt: string;
  scopeLabel: string;
  statusLabel: string;
  missions: DeckMissionRow[];
  decisions: DecisionItem[];
  agents: AgentTile[];
  /** Agents/humans waited on according to the collaboration tree. */
  waitingOnHuman: number;
  agentsAvailable: boolean;
  agentsUnavailableReason?: string;
  nextAction?: { title: string; reason?: string; command?: string };
  health: SourceHealth[];
}

export const EMPTY_SNAPSHOT: DeckSnapshot = {
  generatedAt: '',
  scopeLabel: '',
  statusLabel: '',
  missions: [],
  decisions: [],
  agents: [],
  waitingOnHuman: 0,
  agentsAvailable: false,
  health: [],
};

/** One row of the attention rail. */
export type RailItem =
  | { kind: 'decision'; key: string; lane: 'decide'; decision: DecisionItem }
  | { kind: 'agent'; key: string; lane: 'decide'; agent: AgentTile }
  | { kind: 'mission'; key: string; lane: Lane; mission: DeckMissionRow; agents: AgentTile[] };

export interface RailGroup {
  lane: Lane;
  items: RailItem[];
}
