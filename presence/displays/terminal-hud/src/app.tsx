import { useCallback, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import type { SupportedLocale } from '@agent/core/locale';
import { currentScope } from '@agent/core/scope-context';
import { listDaemonHeartbeatStatuses } from '@agent/core/daemon-heartbeat';
import { resolveIntentResolutionContract } from '@agent/core/intent-resolution-contract';
import { I18nContext, defaultLocale, makeI18n, toggleLocale } from './i18n.js';
import { nextPanel, panelForDigit, type PanelId } from './keymap.js';
import { TabBar } from './components/tab-bar.js';
import { HudHeader } from './components/hud-header.js';
import { StatusBar } from './components/status-bar.js';
import { OperatorCockpit } from './components/operator-cockpit.js';
import { HelpOverlay } from './components/help-overlay.js';
import { PanelBoundary } from './components/panel-boundary.js';
import { InputBar } from './components/input-bar.js';
import { MissionsPanel } from './panels/missions-panel.js';
import { TasksPanel } from './panels/tasks-panel.js';
import { SchedulesPanel } from './panels/schedules-panel.js';
import { ProcessesPanel } from './panels/processes-panel.js';
import { CoordinationPanel } from './panels/coordination-panel.js';
import { StatsPanel } from './panels/stats-panel.js';
import { ProfilePanel } from './panels/profile-panel.js';
import { SettingsPanel } from './panels/settings-panel.js';
import { AgentGraphPanel } from './panels/agent-graph-panel.js';
import { heartbeatSummary } from './store/processes.js';
import { loadSettings } from './store/settings.js';
import { usePollWatch } from './store/use-poll-watch.js';
import { loadOperatorHome, operatorHomeWatchPaths } from './store/operator-home.js';
import { askKyberion } from './actions/ask.js';
import { runPaletteCommand, PALETTE_USAGE } from './actions/palette.js';
import { useVoiceInput } from './voice/use-voice-input.js';
import { theme } from './theme.js';
import type { PanelProps } from './panels/common.js';

export interface AppProps {
  initialPanel?: PanelId;
  initialLocale?: SupportedLocale;
}

const PANEL_COMPONENTS: Record<PanelId, (props: PanelProps) => React.ReactNode> = {
  missions: MissionsPanel,
  tasks: TasksPanel,
  schedules: SchedulesPanel,
  processes: ProcessesPanel,
  coordination: CoordinationPanel,
  stats: StatsPanel,
  profile: ProfilePanel,
  settings: SettingsPanel,
  agents: AgentGraphPanel,
};

interface ConversationLine {
  who: 'you' | 'kyb' | 'sys';
  text: string;
}

const MAX_CONVERSATION_LINES = 6;

function loadStatusLine() {
  let online = 0;
  let total = 0;
  try {
    ({ online, total } = heartbeatSummary(listDaemonHeartbeatStatuses()));
  } catch {
    // heartbeat store may not exist yet
  }
  const settings = loadSettings();
  return {
    online,
    total,
    backend: settings.reasoningMode,
    customer: settings.customer,
  };
}

export function App({ initialPanel, initialLocale }: AppProps) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [locale, setLocale] = useState<SupportedLocale>(initialLocale ?? defaultLocale());
  const i18n = useMemo(() => makeI18n(locale), [locale]);
  const [panel, setPanel] = useState<PanelId>(initialPanel ?? 'missions');
  const [showHelp, setShowHelp] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Conversation is the primary entry point: launch with the composer ready.
  // Esc returns the operator to panel navigation and shortcuts.
  const [inputFocused, setInputFocused] = useState(true);
  const [inputValue, setInputValue] = useState('');
  const [conversation, setConversation] = useState<ConversationLine[]>([]);
  const [lastIntentResolution, setLastIntentResolution] = useState<
    ReturnType<typeof resolveIntentResolutionContract> | undefined
  >();
  const [askBusy, setAskBusy] = useState(false);
  const voice = useVoiceInput();

  const statusLine = usePollWatch({ load: loadStatusLine, intervalMs: 15000 });
  const operatorHome = usePollWatch({
    load: loadOperatorHome,
    watchPaths: operatorHomeWatchPaths(),
    intervalMs: 15000,
    refreshNonce,
  });
  const operatorScope = useMemo(() => {
    try {
      return currentScope();
    } catch {
      return undefined;
    }
  }, []);
  const intentPreview = useMemo(() => {
    const candidate = inputValue.trim();
    if (!inputFocused || !candidate || candidate.startsWith(':')) return undefined;
    try {
      return resolveIntentResolutionContract(candidate, {
        tier: operatorScope?.tier,
        tenantId: operatorScope?.tenant_slug,
      });
    } catch {
      return undefined;
    }
  }, [inputFocused, inputValue, operatorScope]);

  const appendConversation = useCallback((line: ConversationLine) => {
    setConversation((current) => [...current, line].slice(-MAX_CONVERSATION_LINES * 3));
  }, []);

  const toggleVoice = useCallback(async () => {
    const outcome = await voice.toggle();
    if (outcome.error) {
      appendConversation({
        who: 'sys',
        text: i18n.tr('tui:tui_voice_unavailable', { reason: outcome.error }),
      });
    } else if (outcome.text !== undefined) {
      setInputValue(outcome.text);
      setInputFocused(true);
      appendConversation({ who: 'sys', text: i18n.tr('tui:tui_voice_filled') });
    }
  }, [appendConversation, i18n, voice.toggle]);

  const submitInput = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      setInputValue('');
      setInputFocused(false);
      if (!text) return;
      if (text.startsWith(':')) {
        const outcome = await runPaletteCommand(text);
        if (outcome.switchPanel) setPanel(outcome.switchPanel);
        if (!outcome.result.ok && outcome.result.message === text) {
          appendConversation({
            who: 'sys',
            text: `${i18n.tr('tui:tui_palette_unknown', { command: text })}`,
          });
          appendConversation({
            who: 'sys',
            text: `${i18n.tr('tui:tui_palette_usage')}: ${PALETTE_USAGE.join('  ·  ')}`,
          });
        } else {
          appendConversation({
            who: 'sys',
            text: `${outcome.result.ok ? '✔' : '✖'} ${outcome.result.message}`,
          });
        }
        setRefreshNonce((current) => current + 1);
        return;
      }
      appendConversation({ who: 'you', text });
      setAskBusy(true);
      try {
        const reply = await askKyberion(text, i18n.locale);
        setLastIntentResolution(reply.intentResolution);
        appendConversation({
          who: 'kyb',
          text: reply.text || i18n.tr('tui:tui_ask_empty_reply'),
        });
      } finally {
        setAskBusy(false);
      }
    },
    [appendConversation, i18n]
  );

  useInput(
    (input, key) => {
      if (inputFocused) {
        if (key.escape) {
          setInputFocused(false);
          setInputValue('');
        }
        if (key.ctrl && input.toLowerCase() === 'v') {
          void toggleVoice();
        }
        return;
      }
      if (showHelp) {
        if (input === '?' || key.escape) setShowHelp(false);
        return;
      }
      if (input === 'q') {
        exit();
        return;
      }
      if (input === '?') {
        setShowHelp(true);
        return;
      }
      if (input === 'i' || input === '/') {
        setInputFocused(true);
        return;
      }
      if (input === ':') {
        setInputValue(':');
        setInputFocused(true);
        return;
      }
      if (input === 'v') {
        void toggleVoice();
        return;
      }
      if (input === 'L') {
        setLocale((current) => toggleLocale(current));
        return;
      }
      if (input === 'r') {
        setRefreshNonce((current) => current + 1);
        return;
      }
      const byDigit = panelForDigit(input);
      if (byDigit) {
        setPanel(byDigit);
        return;
      }
      if (input === ']' || (key.tab && !key.shift)) {
        setPanel((current) => nextPanel(current, 1));
        return;
      }
      if (input === '[' || (key.tab && key.shift)) {
        setPanel((current) => nextPanel(current, -1));
      }
    },
    { isActive: isRawModeSupported }
  );

  const ActivePanel = PANEL_COMPONENTS[panel];
  const recentConversation = conversation.slice(-MAX_CONVERSATION_LINES);

  return (
    <I18nContext.Provider value={i18n}>
      <Box flexDirection="column">
        <HudHeader
          active={panel}
          daemonsOnline={statusLine.data?.online}
          daemonsTotal={statusLine.data?.total}
        />
        <OperatorCockpit
          summary={operatorHome.data?.summary}
          loading={operatorHome.loading}
          error={operatorHome.error}
          intentPreview={inputFocused ? intentPreview : lastIntentResolution}
          backend={statusLine.data?.backend}
          customer={statusLine.data?.customer}
          tenant={operatorHome.data?.scope.tenant_slug || operatorScope?.tenant_slug}
          voiceState={voice.state}
          agentsWaiting={operatorHome.data?.agentsWaiting}
        />
        <TabBar active={panel} />
        <Box flexDirection="column" borderStyle="round" paddingX={1} minHeight={8}>
          {showHelp ? (
            <HelpOverlay />
          ) : (
            <PanelBoundary key={panel} fallbackPrefix={i18n.tr('tui:tui_error')}>
              <ActivePanel isActive={!showHelp && !inputFocused} refreshNonce={refreshNonce} />
            </PanelBoundary>
          )}
        </Box>
        {recentConversation.length > 0 || askBusy ? (
          <Box flexDirection="column" paddingX={1}>
            {recentConversation.map((line, idx) => (
              <Text
                key={`${line.who}:${idx}`}
                color={
                  line.who === 'you' ? theme.accent : line.who === 'sys' ? theme.dim : undefined
                }
              >
                {line.who === 'you' ? '❯ ' : line.who === 'kyb' ? '● ' : '· '}
                {line.text}
              </Text>
            ))}
          </Box>
        ) : null}
        <InputBar
          focused={inputFocused}
          value={inputValue}
          onChange={setInputValue}
          onSubmit={(value) => void submitInput(value)}
          busy={askBusy}
          voiceState={voice.state}
        />
        <StatusBar
          backend={statusLine.data?.backend}
          customer={statusLine.data?.customer}
          daemonsOnline={statusLine.data?.online}
          daemonsTotal={statusLine.data?.total}
        />
      </Box>
    </I18nContext.Provider>
  );
}
