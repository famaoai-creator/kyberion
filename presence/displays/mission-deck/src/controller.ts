/**
 * Deck controller: key routing and effects, kept out of React so it can be
 * driven directly by tests. All state changes go through DeckStore; all data
 * and effects go through the DeckHost (worker or inline).
 */
import type { Key } from 'ink';
import type { DeckHost } from './data/host.js';
import { DeckStore, type DeckState, type Focus } from './store/deck-store.js';
import { attentionCount, buildRail, flattenRail, reconcileSelection } from './model/attention.js';
import { VIEW_ORDER, type ViewId } from './model/layout.js';
import type {
  AgentTile,
  DeckSnapshot,
  DecisionItem,
  MissionDetail,
  DeckMissionRow,
  RailItem,
} from './model/types.js';
import type { EffectResult } from './actions/effects.js';
import { approvalSpec, attachSpec } from './actions/handoff.js';
import { filterPalette, type PaletteCommand } from './ui/overlays.js';
import type { I18n } from './i18n.js';
import type { HostRequest } from './data/protocol.js';
import { sanitizeTerminalText } from './ui/terminal-text.js';
import type { VocabularyKey } from '@agent/core/t';

export interface TerminalSignals {
  title(text: string): void;
  notify(text: string): void;
}

/** OSC payloads carry requester-authored text (approval titles): strip every
 * control/escape byte (C0, DEL, C1), flatten newlines and cap the length. */
export function oscPayload(text: string): string {
  return sanitizeTerminalText(text).replace(/\s+/gu, ' ').trim().slice(0, 200);
}

export const OSC_SIGNALS: TerminalSignals = {
  title: (text) => process.stdout.write(`\u001b]0;${oscPayload(text)}\u0007`),
  notify: (text) => process.stdout.write(`\u001b]9;${oscPayload(text)}\u0007`),
};

export const NOOP_SIGNALS: TerminalSignals = { title: () => undefined, notify: () => undefined };

const FOCUS_ORDER: Record<ViewId, Focus[]> = {
  conversation: ['composer', 'rail', 'main', 'agents'],
  missions: ['composer', 'rail', 'main'],
  terminals: ['composer', 'agents'],
};

export interface Selection {
  railItems: RailItem[];
  railItem?: RailItem;
  agent?: AgentTile;
  mission?: DeckMissionRow;
  decision?: DecisionItem;
}

export class DeckController {
  constructor(
    readonly store: DeckStore,
    readonly host: DeckHost,
    private i18n: () => I18n,
    private readonly signals: TerminalSignals = NOOP_SIGNALS,
    private readonly hooks: { exit: () => void; toggleLocale: () => void } = {
      exit: () => undefined,
      toggleLocale: () => undefined,
    }
  ) {}

  // ---------------------------------------------------------------- data in

  onSnapshot(snapshot: DeckSnapshot): void {
    const state = this.store.getState();
    const fresh = snapshot.decisions.filter((d) => !state.announced.includes(d.id));
    const items = flattenRail(buildRail(snapshot));
    const sel = reconcileSelection(items, state.railKey, state.railIndex);
    const agentIndex = Math.max(0, Math.min(state.agentIndex, snapshot.agents.length - 1));
    this.store.set({
      snapshot,
      loaded: true,
      railKey: sel.key,
      railIndex: sel.index,
      agentIndex,
      announced: [...state.announced, ...fresh.map((d) => d.id)].slice(-500),
    });
    // Decisions that arrive after launch are announced inline + via OSC 9.
    if (state.loaded) {
      for (const decision of fresh) {
        this.store.pushTurn({ who: 'sys', text: decision.title, decisionId: decision.id });
        this.signals.notify(`Kyberion: ${decision.title}`);
      }
    } else if (fresh.length > 0) {
      this.store.pushTurn({
        who: 'sys',
        text: this.i18n().tr('deck:announce_pending', { count: fresh.length }),
      });
      for (const decision of fresh.slice(0, 2)) {
        this.store.pushTurn({ who: 'sys', text: decision.title, decisionId: decision.id });
      }
    }
    const waiting = attentionCount(snapshot);
    this.signals.title(waiting > 0 ? `◆${waiting} Kyberion Deck` : 'Kyberion Deck');
    this.refreshDetail();
  }

  selection(state: DeckState = this.store.getState()): Selection {
    const railItems = flattenRail(buildRail(state.snapshot));
    const railItem = railItems.find((item) => item.key === state.railKey);
    const agentsFocus = state.focus === 'agents' || state.view === 'terminals';
    let agent: AgentTile | undefined;
    if (agentsFocus) agent = state.snapshot.agents[state.agentIndex];
    else if (railItem?.kind === 'agent') agent = railItem.agent;
    else if (railItem?.kind === 'mission') agent = railItem.agents[0];

    let missionId: string | undefined;
    if (agentsFocus) missionId = agent?.missionId;
    else if (railItem?.kind === 'mission') missionId = railItem.mission.id;
    else if (railItem?.kind === 'decision') missionId = railItem.decision.missionId;
    else if (railItem?.kind === 'agent') missionId = railItem.agent.missionId;
    const mission = missionId ? state.snapshot.missions.find((m) => m.id === missionId) : undefined;

    let decision: DecisionItem | undefined;
    if (!agentsFocus && railItem?.kind === 'decision') decision = railItem.decision;
    else if (state.view === 'conversation' && state.focus === 'main') {
      const pending = new Set(state.snapshot.decisions.map((d) => d.id));
      const lastCard = [...state.transcript]
        .reverse()
        .find((t) => t.decisionId && pending.has(t.decisionId));
      decision = state.snapshot.decisions.find((d) => d.id === lastCard?.decisionId);
    }
    return { railItems, railItem, agent, mission, decision };
  }

  private refreshDetail(): void {
    const { mission } = this.selection();
    if (mission) void this.loadDetail(mission);
  }

  private detailSeq = new Map<string, number>();

  async loadDetail(mission: DeckMissionRow): Promise<void> {
    // Responses can arrive out of order; only the latest request per mission wins.
    const seq = (this.detailSeq.get(mission.id) ?? 0) + 1;
    this.detailSeq.set(mission.id, seq);
    let detail: MissionDetail | null = null;
    try {
      detail =
        ((await this.host.request({ op: 'missionDetail', id: mission.id, row: mission })) as
          MissionDetail | undefined) ?? null;
    } catch {
      detail = null;
    }
    if (this.detailSeq.get(mission.id) !== seq) return;
    this.store.set((state) => ({ details: { ...state.details, [mission.id]: detail } }));
  }

  // ------------------------------------------------------------- navigation

  setView(view: ViewId): void {
    const focus = this.store.getState().focus;
    const allowed = FOCUS_ORDER[view];
    this.store.set({ view, focus: allowed.includes(focus) ? focus : (allowed[1] ?? 'composer') });
    this.refreshDetail();
  }

  cycleFocus(direction: 1 | -1): void {
    const state = this.store.getState();
    const order = FOCUS_ORDER[state.view];
    const index = order.indexOf(state.focus);
    const next = order[(index + direction + order.length) % order.length]!;
    this.store.set({ focus: next });
  }

  move(delta: number): void {
    const state = this.store.getState();
    if (state.focus === 'agents' || state.view === 'terminals') {
      const count = state.snapshot.agents.length;
      if (count === 0) return;
      this.store.set({ agentIndex: (state.agentIndex + delta + count) % count });
      return;
    }
    const items = flattenRail(buildRail(state.snapshot));
    if (items.length === 0) return;
    const index = Math.max(0, Math.min(items.length - 1, state.railIndex + delta));
    this.store.set({ railIndex: index, railKey: items[index]!.key });
    this.refreshDetail();
  }

  gotoDecision(): void {
    const state = this.store.getState();
    const items = flattenRail(buildRail(state.snapshot));
    const index = items.findIndex((item) => item.lane === 'decide');
    if (index < 0) {
      this.store.toast(true, this.i18n().tr('deck:toast_nothing_waiting'));
      return;
    }
    this.store.set({
      railIndex: index,
      railKey: items[index]!.key,
      focus: 'rail',
      view: state.view === 'terminals' ? 'conversation' : state.view,
    });
  }

  // ---------------------------------------------------------------- effects

  /** Effects never reject: a worker/host failure becomes a failed result. */
  private async effect(request: HostRequest): Promise<EffectResult> {
    try {
      const result = (await this.host.request(request)) as EffectResult | undefined;
      return result ?? { ok: false, message: '' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private failText(failKey: VocabularyKey, message: string): string {
    const tr = this.i18n().tr;
    const reason = oscPayload(message).slice(0, 120) || tr('deck:reason_unknown');
    return tr(failKey, { reason });
  }

  private report(result: EffectResult, okText: string, failKey: VocabularyKey): void {
    this.store.toast(result.ok, result.ok ? okText : this.failText(failKey, result.message));
  }

  async submitConversation(text: string): Promise<void> {
    const trimmed = text.trim();
    const state = this.store.getState();
    if (!trimmed) return;
    if (state.busy) {
      this.store.toast(false, this.i18n().tr('deck:toast_busy'));
      return;
    }
    this.store.set({ draft: '', busy: true });
    this.store.pushTurn({ who: 'you', text: trimmed });
    try {
      const result = (await this.host.request({
        op: 'ask',
        text: trimmed,
        threadTs: state.threadTs,
        locale: this.i18n().locale,
      })) as EffectResult;
      this.store.pushTurn({
        who: result.ok ? 'kyb' : 'sys',
        text: result.ok
          ? result.message || this.i18n().tr('deck:reply_empty')
          : this.failText('deck:fail_ask', result.message),
        ...(result.intent ? { intent: result.intent } : {}),
      });
    } catch (err) {
      this.store.pushTurn({
        who: 'sys',
        text: this.failText('deck:fail_ask', err instanceof Error ? err.message : String(err)),
      });
    } finally {
      this.store.set({ busy: false });
    }
  }

  openSteer(): void {
    const { agent, mission } = this.selection();
    const state = this.store.getState();
    const preferAgent = state.focus === 'agents' || state.view === 'terminals' || !mission;
    if (preferAgent && agent) {
      this.store.set({
        overlay: { kind: 'steer', target: { kind: 'agent', target: agent.target }, draft: '' },
      });
    } else if (mission) {
      this.store.set({
        overlay: { kind: 'steer', target: { kind: 'mission', missionId: mission.id }, draft: '' },
      });
    } else {
      this.store.toast(false, this.i18n().tr('deck:toast_select_target'));
    }
  }

  async submitSteer(draft: string): Promise<void> {
    const overlay = this.store.getState().overlay;
    if (overlay.kind !== 'steer') return;
    const text = draft.trim();
    this.store.set({ overlay: { kind: 'none' } });
    if (!text) return;
    const tr = this.i18n().tr;
    if (overlay.target.kind === 'agent') {
      const result = (await this.effect({
        op: 'agentPrompt',
        target: overlay.target.target,
        text,
      })) as EffectResult;
      this.report(result, tr('deck:toast_sent_agent'), 'deck:fail_agent_send');
    } else {
      const mission = this.store
        .getState()
        .snapshot.missions.find(
          (m) => m.id === (overlay.target as { missionId: string }).missionId
        );
      const result = (await this.effect({
        op: 'steer',
        missionId: overlay.target.missionId,
        text,
        delivery: 'steer',
        ...(mission?.tier ? { tier: mission.tier } : {}),
        ...(mission?.tenantSlug ? { tenantSlug: mission.tenantSlug } : {}),
      })) as EffectResult;
      this.report(result, tr('deck:toast_steer_queued'), 'deck:fail_steer');
    }
  }

  openPeek(): void {
    const { agent, decision } = this.selection();
    if (agent && !decision) {
      this.store.set({ overlay: { kind: 'peek', target: agent.target, draft: '' } });
    } else if (decision) {
      this.store.set({ view: 'conversation', focus: 'main' });
      const state = this.store.getState();
      if (!state.transcript.some((turn) => turn.decisionId === decision.id)) {
        this.store.pushTurn({ who: 'sys', text: decision.title, decisionId: decision.id });
      }
    }
  }

  async submitPeek(draft: string): Promise<void> {
    const overlay = this.store.getState().overlay;
    if (overlay.kind !== 'peek') return;
    const text = draft.trim();
    if (!text) return;
    this.store.set({ overlay: { ...overlay, draft: '' } });
    const result = (await this.effect({
      op: 'agentPrompt',
      target: overlay.target,
      text,
    })) as EffectResult;
    this.report(result, this.i18n().tr('deck:toast_sent_agent'), 'deck:fail_agent_send');
  }

  enter(): void {
    const state = this.store.getState();
    const { agent, railItem, decision } = this.selection();
    const tr = this.i18n().tr;
    if (
      agent &&
      (state.focus === 'agents' || state.view === 'terminals' || railItem?.kind === 'agent')
    ) {
      this.handoff(attachSpec(agent.target, tr('deck:handoff_attach', { name: agent.name })));
      return;
    }
    if (decision) {
      this.openPeek();
      return;
    }
    if (railItem?.kind === 'mission') {
      this.setView('missions');
      this.store.set({ focus: 'main' });
    }
  }

  confirmDecision(decisionChoice: 'approve' | 'deny'): void {
    const { decision } = this.selection();
    const tr = this.i18n().tr;
    if (!decision) {
      this.store.toast(false, tr('deck:toast_select_decision'));
      return;
    }
    this.store.set({
      overlay: {
        kind: 'confirm',
        action: { kind: 'approval', id: decision.id, decision: decisionChoice },
        text: [
          tr(decisionChoice === 'approve' ? 'deck:confirm_approve' : 'deck:confirm_deny', {
            title: decision.title,
          }),
          decision.reversible ? tr('deck:card_reversible') : tr('deck:card_irreversible'),
          tr('deck:confirm_opens_approval'),
        ].join('\n'),
      },
    });
  }

  confirmInterrupt(): void {
    const state = this.store.getState();
    const { agent, railItem } = this.selection();
    const tr = this.i18n().tr;
    const agentTargeted =
      state.focus === 'agents' || state.view === 'terminals' || railItem?.kind === 'agent';
    if (agent && agentTargeted) {
      this.store.set({
        overlay: {
          kind: 'confirm',
          action: { kind: 'interrupt', target: agent.target },
          text: tr('deck:confirm_interrupt', { name: agent.name }),
        },
      });
    } else {
      this.store.toast(false, tr('deck:toast_select_agent'));
    }
  }

  confirmPause(): void {
    const { mission } = this.selection();
    const tr = this.i18n().tr;
    if (!mission) {
      this.store.toast(false, tr('deck:toast_select_target'));
      return;
    }
    this.store.set({
      overlay: {
        kind: 'confirm',
        action: { kind: 'pause', missionId: mission.id },
        text: tr('deck:confirm_pause', { title: mission.goal || mission.id }),
      },
    });
  }

  async acceptConfirm(): Promise<void> {
    const overlay = this.store.getState().overlay;
    if (overlay.kind !== 'confirm') return;
    this.store.set({ overlay: { kind: 'none' } });
    const tr = this.i18n().tr;
    const action = overlay.action;
    switch (action.kind) {
      case 'approval':
        this.handoff(approvalSpec(action.id, action.decision, tr('deck:handoff_approval')));
        return;
      case 'interrupt': {
        const result = (await this.effect({
          op: 'agentInterrupt',
          target: action.target,
        })) as EffectResult;
        this.report(result, tr('deck:toast_interrupted'), 'deck:fail_interrupt');
        return;
      }
      case 'pause': {
        this.store.toast(true, tr('deck:toast_working'));
        const result = (await this.effect({
          op: 'mission',
          verb: 'pause',
          missionId: action.missionId,
        })) as EffectResult;
        this.report(result, tr('deck:toast_paused'), 'deck:fail_mission');
        return;
      }
    }
  }

  async missionVerb(verb: 'resume' | 'checkpoint'): Promise<void> {
    const { mission } = this.selection();
    const tr = this.i18n().tr;
    if (!mission) {
      this.store.toast(false, tr('deck:toast_select_target'));
      return;
    }
    this.store.toast(true, tr('deck:toast_working'));
    const result = (await this.effect({
      op: 'mission',
      verb,
      missionId: mission.id,
    })) as EffectResult;
    this.report(result, tr('deck:toast_done'), 'deck:fail_mission');
  }

  handoff(spec: NonNullable<DeckState['handoff']>): void {
    this.store.set({ handoff: spec });
    this.hooks.exit();
  }

  quit(): void {
    this.store.set({ quitting: true });
    this.hooks.exit();
  }

  // ---------------------------------------------------------------- palette

  paletteCommands(): PaletteCommand[] {
    const tr = this.i18n().tr;
    return [
      { id: 'view.conversation', label: tr('deck:view_conversation'), hint: '1' },
      { id: 'view.missions', label: tr('deck:view_missions'), hint: '2' },
      { id: 'view.terminals', label: tr('deck:view_terminals'), hint: '3' },
      { id: 'goto.decision', label: tr('deck:help_goto_decision'), hint: 'g' },
      { id: 'mission.resume', label: tr('deck:palette_resume') },
      { id: 'mission.checkpoint', label: tr('deck:palette_checkpoint') },
      { id: 'mission.pause', label: tr('deck:help_pause'), hint: 'p' },
      { id: 'refresh', label: tr('deck:help_refresh'), hint: 'r' },
      { id: 'locale', label: tr('deck:help_locale'), hint: 'L' },
      { id: 'help', label: tr('deck:help_title'), hint: '?' },
      { id: 'quit', label: tr('deck:help_quit'), hint: 'q' },
    ];
  }

  runPalette(): void {
    const overlay = this.store.getState().overlay;
    if (overlay.kind !== 'palette') return;
    const match = filterPalette(this.paletteCommands(), overlay.query)[overlay.index];
    this.store.set({ overlay: { kind: 'none' } });
    if (!match) return;
    switch (match.id) {
      case 'view.conversation':
        return this.setView('conversation');
      case 'view.missions':
        return this.setView('missions');
      case 'view.terminals':
        return this.setView('terminals');
      case 'goto.decision':
        return this.gotoDecision();
      case 'mission.resume':
        return void this.missionVerb('resume');
      case 'mission.checkpoint':
        return void this.missionVerb('checkpoint');
      case 'mission.pause':
        return this.confirmPause();
      case 'refresh':
        return this.host.refresh();
      case 'locale':
        return this.hooks.toggleLocale();
      case 'help':
        return this.store.set({ overlay: { kind: 'help' } });
      case 'quit':
        return this.quit();
    }
  }

  // ------------------------------------------------------------------- keys

  /** Returns true when the key was consumed. */
  handleKey(input: string, key: Key): boolean {
    const state = this.store.getState();
    const overlay = state.overlay;

    if (key.ctrl && input === 'p') {
      if (state.focus === 'composer' && overlay.kind === 'none') {
        const draft = state.draft;
        setTimeout(() => this.store.set({ draft }), 0);
      }
      this.store.set({
        overlay:
          overlay.kind === 'palette' ? { kind: 'none' } : { kind: 'palette', query: '', index: 0 },
      });
      return true;
    }

    if (overlay.kind !== 'none') {
      if (key.escape) {
        this.store.set({ overlay: { kind: 'none' } });
        return true;
      }
      if (overlay.kind === 'help') {
        this.store.set({ overlay: { kind: 'none' } });
        return true;
      }
      if (overlay.kind === 'confirm') {
        if (input === 'y' || input === 'Y') void this.acceptConfirm();
        else if (input === 'n' || input === 'N') this.store.set({ overlay: { kind: 'none' } });
        return true;
      }
      if (overlay.kind === 'palette') {
        const count = filterPalette(this.paletteCommands(), overlay.query).length;
        if (key.upArrow)
          this.store.set({ overlay: { ...overlay, index: Math.max(0, overlay.index - 1) } });
        if (key.downArrow)
          this.store.set({
            overlay: { ...overlay, index: Math.min(Math.max(0, count - 1), overlay.index + 1) },
          });
        return true;
      }
      if (overlay.kind === 'peek' && key.tab) {
        // Tab from peek attaches to the real terminal.
        const agent = state.snapshot.agents.find((a) => a.target === overlay.target);
        if (agent) {
          this.store.set({ overlay: { kind: 'none' } });
          this.handoff(
            attachSpec(agent.target, this.i18n().tr('deck:handoff_attach', { name: agent.name }))
          );
        }
        return true;
      }
      return false; // text inputs inside overlays handle the rest
    }

    if (state.focus === 'composer') {
      if (key.escape) {
        this.store.set({ focus: 'rail' });
        return true;
      }
      if (key.tab) {
        this.cycleFocus(key.shift ? -1 : 1);
        return true;
      }
      return false; // TextInput consumes typing and Enter
    }

    if (key.tab) {
      this.cycleFocus(key.shift ? -1 : 1);
      return true;
    }
    if (key.upArrow || input === 'k') {
      this.move(-1);
      return true;
    }
    if (key.downArrow || input === 'j') {
      this.move(1);
      return true;
    }
    if (key.leftArrow && state.view === 'terminals') {
      this.move(-1);
      return true;
    }
    if (key.rightArrow && state.view === 'terminals') {
      this.move(1);
      return true;
    }
    if (key.return) {
      this.enter();
      return true;
    }
    if (key.escape) {
      this.store.set({ focus: 'composer' });
      return true;
    }
    switch (input) {
      case '1':
      case '2':
      case '3':
        this.setView(VIEW_ORDER[Number(input) - 1]!);
        return true;
      case 'i':
      case '/':
        this.store.set({ focus: 'composer' });
        return true;
      case ' ':
        this.openPeek();
        return true;
      case 'a':
        this.confirmDecision('approve');
        return true;
      case 'd':
        this.confirmDecision('deny');
        return true;
      case 's':
        this.openSteer();
        return true;
      case '!':
        this.confirmInterrupt();
        return true;
      case 'p':
        this.confirmPause();
        return true;
      case 'g':
        this.gotoDecision();
        return true;
      case 'r':
        this.host.refresh();
        this.store.toast(true, this.i18n().tr('deck:toast_refreshing'));
        return true;
      case 'L':
        this.hooks.toggleLocale();
        return true;
      case '?':
        this.store.set({ overlay: { kind: 'help' } });
        return true;
      case 'q':
        this.quit();
        return true;
    }
    return false;
  }
}
