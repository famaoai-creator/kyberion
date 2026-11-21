import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Box, useApp, useInput, useWindowSize } from 'ink';
import { currentScope } from '@agent/core/scope-context';
import type { SupportedLocale } from '@agent/core/locale';
import { I18nContext, makeI18n, toggleLocale } from './i18n.js';
import type { DeckHost } from './data/host.js';
import { DeckStore } from './store/deck-store.js';
import { DeckController, NOOP_SIGNALS, type TerminalSignals } from './controller.js';
import { buildRail, deckCounts } from './model/attention.js';
import { computeLayout } from './model/layout.js';
import {
  Header,
  Rail,
  Conversation,
  MissionDetailView,
  AgentColumn,
  AgentGrid,
} from './ui/panes.js';
import { Composer, Footer } from './ui/composer.js';
import {
  ConfirmOverlay,
  HelpOverlay,
  PaletteOverlay,
  PeekOverlay,
  SteerOverlay,
} from './ui/overlays.js';
import type { VocabularyKey } from '@agent/core/t';

export interface AppProps {
  store: DeckStore;
  host: DeckHost;
  locale: SupportedLocale;
  onLocaleChange?: (locale: SupportedLocale) => void;
  signals?: TerminalSignals;
  /** Fixed size for tests; defaults to the live terminal size. */
  size?: { columns: number; rows: number };
}

/** Footer hint for what the keys will act on right now. */
export function hintKey(view: string, focus: string, railKind?: string): VocabularyKey {
  if (focus === 'composer') return 'deck:hint_composer';
  if (view === 'terminals') return 'deck:hint_terminals';
  if (focus === 'agents') return 'deck:hint_agents';
  if (focus === 'main')
    return view === 'missions' ? 'deck:hint_main_missions' : 'deck:hint_main_conversation';
  if (railKind === 'decision') return 'deck:hint_rail_decision';
  if (railKind === 'mission') return 'deck:hint_rail_mission';
  if (railKind === 'agent') return 'deck:hint_rail_agent';
  return 'deck:hint_rail';
}

export function App(props: AppProps) {
  const { exit } = useApp();
  const live = useWindowSize();
  const size = props.size ?? live;
  const state = useSyncExternalStore(props.store.subscribe, props.store.getState);
  const i18n = useMemo(() => makeI18n(props.locale), [props.locale]);
  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;
  const localeRef = useRef(props.locale);
  localeRef.current = props.locale;

  const controller = useMemo(
    () =>
      new DeckController(
        props.store,
        props.host,
        () => i18nRef.current,
        props.signals ?? NOOP_SIGNALS,
        {
          exit,
          toggleLocale: () => props.onLocaleChange?.(toggleLocale(localeRef.current)),
        }
      ),
    // Created once per store/host; i18n and locale are read through refs.
    [props.store, props.host]
  );

  useEffect(
    () => props.host.subscribe((snapshot) => controller.onSnapshot(snapshot)),
    [controller, props.host]
  );

  useInput((input, key) => {
    controller.handleKey(input, key);
  });

  const scope = useMemo(() => {
    try {
      const s = currentScope();
      return { tier: s.tier, ...(s.tenant_slug ? { tenantId: s.tenant_slug } : {}) };
    } catch {
      return {};
    }
  }, []);

  const snapshot = state.snapshot;
  const groups = buildRail(snapshot);
  const counts = deckCounts(snapshot);
  const layout = computeLayout(size.columns, size.rows, state.view, snapshot.agents.length);
  const selection = controller.selection(state);
  const overlay = state.overlay;
  const tr = i18n.tr;

  const rail = (width: number) => (
    <Rail
      groups={groups}
      selectedKey={state.railKey}
      focused={state.focus === 'rail'}
      width={width}
      rows={layout.bodyRows}
    />
  );
  const conversation = (width: number) => (
    <Conversation
      transcript={state.transcript}
      decisions={snapshot.decisions}
      busy={state.busy}
      width={width}
      rows={layout.bodyRows}
      focused={state.focus === 'main' || state.focus === 'composer'}
      nextAction={snapshot.nextAction}
    />
  );
  const detail = (width: number) => (
    <MissionDetailView
      mission={selection.mission}
      detail={selection.mission ? state.details[selection.mission.id] : undefined}
      agents={snapshot.agents.filter((a) => a.missionId && a.missionId === selection.mission?.id)}
      width={width}
      rows={layout.bodyRows}
      focused={state.focus === 'main'}
    />
  );
  const agentColumn = (width: number) => (
    <AgentColumn
      agents={snapshot.agents}
      missions={snapshot.missions}
      available={snapshot.agentsAvailable}
      reason={snapshot.agentsUnavailableReason}
      selectedIndex={state.agentIndex}
      focused={state.focus === 'agents'}
      width={width}
      rows={layout.bodyRows}
    />
  );
  const grid = (
    <AgentGrid
      agents={snapshot.agents}
      missions={snapshot.missions}
      available={snapshot.agentsAvailable}
      reason={snapshot.agentsUnavailableReason}
      selectedIndex={state.agentIndex}
      cols={layout.grid.cols}
      tileWidth={layout.grid.tileWidth}
      tileRows={layout.grid.tileRows}
      rows={layout.bodyRows}
      width={layout.mainWidth}
    />
  );

  let body: React.ReactNode;
  if (layout.compact) {
    // One region at a time; the focused one wins.
    const width = layout.columns;
    if (state.view === 'terminals') body = grid;
    else if (state.focus === 'rail') body = rail(width);
    else if (state.focus === 'agents') body = agentColumn(width);
    else body = state.view === 'missions' ? detail(width) : conversation(width);
  } else if (state.view === 'terminals') {
    body = grid;
  } else {
    body = (
      <Box>
        {rail(layout.railWidth)}
        {state.view === 'missions' ? detail(layout.mainWidth) : conversation(layout.mainWidth)}
        {state.view === 'conversation' ? agentColumn(layout.agentsWidth) : null}
      </Box>
    );
  }

  const overlayWidth = Math.min(layout.columns, Math.max(50, Math.floor(layout.columns * 0.7)));
  let overlayNode: React.ReactNode = null;
  if (overlay.kind === 'help') overlayNode = <HelpOverlay width={overlayWidth} />;
  else if (overlay.kind === 'palette')
    overlayNode = (
      <PaletteOverlay
        width={overlayWidth}
        query={overlay.query}
        index={overlay.index}
        commands={controller.paletteCommands()}
        onChange={(query) => props.store.set({ overlay: { kind: 'palette', query, index: 0 } })}
        onSubmit={() => controller.runPalette()}
      />
    );
  else if (overlay.kind === 'peek')
    overlayNode = (
      <PeekOverlay
        width={overlayWidth}
        rows={layout.bodyRows}
        agent={snapshot.agents.find((a) => a.target === overlay.target)}
        draft={overlay.draft}
        onChange={(draft) => props.store.set({ overlay: { ...overlay, draft } })}
        onSubmit={(draft) => void controller.submitPeek(draft)}
      />
    );
  else if (overlay.kind === 'steer')
    overlayNode = (
      <SteerOverlay
        width={overlayWidth}
        title={
          overlay.target.kind === 'agent'
            ? tr('deck:steer_title_agent', { name: overlay.target.target })
            : tr('deck:steer_title_mission', {
                title:
                  snapshot.missions.find(
                    (m) => overlay.target.kind === 'mission' && m.id === overlay.target.missionId
                  )?.goal || overlay.target.missionId,
              })
        }
        draft={overlay.draft}
        onChange={(draft) => props.store.set({ overlay: { ...overlay, draft } })}
        onSubmit={(draft) => void controller.submitSteer(draft)}
      />
    );
  else if (overlay.kind === 'confirm')
    overlayNode = <ConfirmOverlay width={overlayWidth} text={overlay.text} />;

  return (
    <I18nContext.Provider value={i18n}>
      <Box flexDirection="column" width={layout.columns} height={layout.rows}>
        <Header
          width={layout.columns}
          scopeLabel={snapshot.scopeLabel}
          counts={counts}
          view={state.view}
          loaded={state.loaded}
          compact={layout.columns < 140}
          degraded={snapshot.health.filter((h) => !h.ok && h.source !== 'agents').length}
        />
        {overlayNode ? (
          <Box height={layout.bodyRows} justifyContent="center" alignItems="flex-start">
            {overlayNode}
          </Box>
        ) : (
          body
        )}
        <Composer
          value={state.draft}
          focused={state.focus === 'composer' && overlay.kind === 'none'}
          busy={state.busy}
          width={layout.columns}
          scope={scope}
          onChange={(draft) => props.store.set({ draft })}
          onSubmit={(text) => void controller.submitConversation(text)}
        />
        <Footer
          width={layout.columns}
          toast={state.toast}
          hints={tr(hintKey(state.view, state.focus, selection.railItem?.kind))}
        />
      </Box>
    </I18nContext.Provider>
  );
}
