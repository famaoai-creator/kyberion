import { Box } from 'ink';
import { Text } from './text.js';
import { useI18n } from '../i18n.js';
import { fitWidth } from '../model/layout.js';
import {
  PHASE_ORDER,
  type AgentTile,
  type DecisionItem,
  type MissionDetail,
  type DeckMissionRow,
  type RailGroup,
  type RailItem,
} from '../model/types.js';
import type { DeckCounts } from '../model/attention.js';
import type { ViewId } from '../model/layout.js';
import type { Turn } from '../store/deck-store.js';
import {
  AGENT_COLOR,
  AGENT_GLYPH,
  LANE_COLOR,
  LANE_GLYPH,
  PHASE_LABEL_KEYS,
  taskGlyph,
  theme,
} from './theme.js';
import { artifactTitle, humanize, shapeLabel } from './labels.js';
import type { VocabularyKey } from '@agent/core/t';

const VIEW_KEYS: Record<ViewId, VocabularyKey> = {
  conversation: 'deck:view_conversation',
  missions: 'deck:view_missions',
  terminals: 'deck:view_terminals',
};

/** "provider · name", or just the name when herdr names the agent after its provider. */
export function agentLabel(agent: Pick<AgentTile, 'name' | 'provider'>): string {
  return agent.provider && agent.provider !== agent.name
    ? `${agent.provider} · ${agent.name}`
    : agent.name;
}

export function Header(props: Parameters<typeof HeaderRow>[0]) {
  const { tr } = useI18n();
  // Two rows are reserved for the header (layout HEADER_ROWS); the second
  // carries the degraded-source warning so it never competes with the counts.
  return (
    <Box flexDirection="column" width={props.width}>
      <HeaderRow {...props} />
      {props.degraded ? (
        <Text color={theme.warn} wrap="truncate-end">
          {tr('deck:degraded_header', { count: props.degraded })}
        </Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}

function HeaderRow(props: {
  width: number;
  scopeLabel: string;
  counts: DeckCounts;
  view: ViewId;
  loaded: boolean;
  compact?: boolean;
  /** Sources that failed to load (agents excluded: the agents area explains itself). */
  degraded?: number;
}) {
  const { tr } = useI18n();
  return (
    <Box width={props.width} justifyContent="space-between">
      <Box flexShrink={1} overflow="hidden">
        <Box flexShrink={0}>
          <Text bold color={theme.brand}>
            KYBERION
          </Text>
        </Box>
        <Text color={theme.muted} wrap="truncate-end">
          {' '}
          ▸ {props.scopeLabel || '…'}{' '}
        </Text>
        <Text color={LANE_COLOR.decide}>
          {' '}
          {LANE_GLYPH.decide} {tr('deck:count_decide', { count: props.counts.decide })}
        </Text>
        <Text color={LANE_COLOR.running}>
          {'  '}
          {LANE_GLYPH.running} {tr('deck:count_running', { count: props.counts.running })}
        </Text>
        <Text color={LANE_COLOR.review}>
          {'  '}
          {LANE_GLYPH.review} {tr('deck:count_review', { count: props.counts.review })}
        </Text>
        {!props.loaded ? (
          <Text color={theme.muted}>
            {'  '}
            {tr('deck:loading')}
          </Text>
        ) : null}
      </Box>
      <Box flexShrink={0}>
        {(['conversation', 'missions', 'terminals'] as ViewId[]).map((view, index) => (
          <Text
            key={view}
            {...(view === props.view ? { inverse: true, bold: true } : { color: theme.muted })}
          >
            {props.compact && view !== props.view
              ? ` ${index + 1} `
              : ` ${index + 1} ${tr(VIEW_KEYS[view])} `}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

const LANE_KEYS: Record<RailGroup['lane'], VocabularyKey> = {
  decide: 'deck:lane_decide',
  review: 'deck:lane_review',
  blocked: 'deck:lane_blocked',
  running: 'deck:lane_running',
  done: 'deck:lane_done',
};

export function railItemLabel(item: RailItem): string {
  switch (item.kind) {
    case 'decision':
      return item.decision.title;
    case 'agent':
      return item.agent.name;
    case 'mission':
      return item.mission.goal || item.mission.id;
  }
}

function railItemTag(item: RailItem, tr: (key: VocabularyKey) => string): string {
  switch (item.kind) {
    case 'decision':
      return tr('deck:tag_approval');
    case 'agent':
      return tr('deck:tag_input');
    case 'mission':
      if (item.agents.length > 0) {
        return item.agents
          .map((agent) => `${AGENT_GLYPH[agent.state]}${agent.provider ?? agent.name}`)
          .join(' ');
      }
      return '';
  }
}

export function Rail(props: {
  groups: RailGroup[];
  selectedKey?: string;
  focused: boolean;
  width: number;
  rows: number;
}) {
  const { tr } = useI18n();
  const lines: { key: string; node: React.ReactNode }[] = [];
  for (const group of props.groups) {
    lines.push({
      key: `lane:${group.lane}`,
      node: (
        <Text color={LANE_COLOR[group.lane]} bold>
          {LANE_GLYPH[group.lane]} {tr(LANE_KEYS[group.lane])} ({group.items.length})
        </Text>
      ),
    });
    for (const item of group.items) {
      const selected = item.key === props.selectedKey;
      const tag = railItemTag(item, tr);
      const tagWidth = Math.min(14, tag.length ? tag.length + 1 : 0);
      const labelWidth = Math.max(4, props.width - 4 - tagWidth);
      lines.push({
        key: item.key,
        node: (
          <Box>
            <Text
              {...(selected && props.focused
                ? { inverse: true }
                : selected
                  ? { bold: true, color: theme.focus }
                  : {})}
            >
              {selected ? '▸ ' : '  '}
              {fitWidth(railItemLabel(item), labelWidth).padEnd(labelWidth)}
            </Text>
            {tag ? <Text color={theme.muted}> {fitWidth(tag, tagWidth - 1)}</Text> : null}
          </Box>
        ),
      });
    }
  }
  if (lines.length === 0) {
    lines.push({
      key: 'empty',
      node: (
        <Text color={theme.muted} wrap="wrap">
          {tr('deck:rail_empty')}
        </Text>
      ),
    });
  }
  // Keep the selection visible: scroll window around it.
  const selectedLine = Math.max(
    0,
    lines.findIndex((line) => line.key === props.selectedKey)
  );
  const budget = Math.max(3, props.rows - 2);
  const start = Math.max(0, Math.min(selectedLine - Math.floor(budget / 2), lines.length - budget));
  const visible = lines.slice(start, start + budget);
  return (
    <Box
      flexDirection="column"
      width={props.width}
      height={props.rows}
      borderStyle={props.focused ? 'bold' : 'round'}
      borderColor={props.focused ? theme.focus : theme.muted}
      paddingX={0}
    >
      {visible.map((line) => (
        <Box key={line.key}>{line.node}</Box>
      ))}
    </Box>
  );
}

export function PhaseStrip({ phase }: { phase: MissionDetail['phase'] }) {
  const { tr } = useI18n();
  const current = PHASE_ORDER.indexOf(phase);
  return (
    <Box>
      {PHASE_ORDER.map((step, index) => (
        <Text
          key={step}
          {...(index === current
            ? { bold: true, color: theme.accent }
            : index < current
              ? { color: theme.ok }
              : { color: theme.muted })}
        >
          {index > 0 ? ' ─ ' : ''}
          {index === current ? '●' : index < current ? '✓' : '○'}
          {tr(PHASE_LABEL_KEYS[step])}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Approval questions can carry long multi-line task/result text. Inline cards
 * have a fixed row budget, so show only the first non-empty lines (the full
 * text stays one keypress away in the governed approval CLI).
 */
export function questionLines(question: string | undefined, max: number): string[] {
  const lines = (question ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max - 1), `${lines[max - 1]} …`];
}

export function DecisionCard(props: {
  decision: DecisionItem;
  width: number;
  compact?: boolean;
  /** The card a / d act on in the conversation (newest pending). */
  active?: boolean;
}) {
  const { tr } = useI18n();
  const d = props.decision;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={LANE_COLOR.decide}
      width={Math.max(20, props.width)}
      paddingX={1}
    >
      <Text bold color={LANE_COLOR.decide} wrap="truncate-end">
        {props.active ? '▶ ' : ''}
        {LANE_GLYPH.decide} {d.title}
      </Text>
      {questionLines(d.question, props.compact ? 2 : 6).map((line, index) => (
        <Text key={`q${index}`} wrap="truncate-end">
          {fitWidth(line, Math.max(10, props.width - 4))}
        </Text>
      ))}
      {d.recommendation ? (
        <Text wrap="wrap">
          <Text color={theme.muted}>{tr('deck:card_recommendation')}: </Text>
          {d.recommendation}
        </Text>
      ) : null}
      {!props.compact
        ? d.reasons.slice(0, 3).map((reason, index) => (
            <Text key={index} color={theme.muted} wrap="truncate-end">
              • {reason}
            </Text>
          ))
        : null}
      <Text wrap="wrap">
        <Text color={theme.muted}>{tr('deck:card_if_no_response')}: </Text>
        {d.ifNoResponse}
      </Text>
      <Text color={theme.muted}>
        {d.reversible ? tr('deck:card_reversible') : tr('deck:card_irreversible')}
      </Text>
      {props.active === false ? (
        <Text color={theme.muted}>{tr('deck:card_other')}</Text>
      ) : (
        <Text>
          <Text color={theme.ok}>[a] {tr('deck:action_approve')}</Text>
          {'  '}
          <Text color={theme.danger}>[d] {tr('deck:action_deny')}</Text>
        </Text>
      )}
    </Box>
  );
}

export function AgentTileView(props: {
  agent: AgentTile;
  width: number;
  rows: number;
  selected: boolean;
  focused: boolean;
  missionLabel?: string;
}) {
  const { tr } = useI18n();
  const a = props.agent;
  const tailRows = Math.max(1, props.rows - 3);
  const inner = Math.max(8, props.width - 4);
  return (
    <Box
      flexDirection="column"
      width={props.width}
      height={props.rows}
      borderStyle={props.selected && props.focused ? 'double' : props.selected ? 'bold' : 'round'}
      borderColor={props.selected && props.focused ? theme.focus : AGENT_COLOR[a.state]}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold wrap="truncate-end">
          {fitWidth(agentLabel(a), inner - 10)}
        </Text>
        <Text color={AGENT_COLOR[a.state]}>
          {AGENT_GLYPH[a.state]} {tr(`deck:agent_${a.state}` as VocabularyKey)}
        </Text>
      </Box>
      <Text color={theme.muted} wrap="truncate-end">
        {props.missionLabel ? `↳ ${props.missionLabel}` : tr('deck:agent_unlinked')}
      </Text>
      {a.tail.slice(-tailRows).map((line, index) => (
        <Text
          key={index}
          wrap="truncate-end"
          color={index === a.tail.slice(-tailRows).length - 1 ? undefined : theme.muted}
        >
          {fitWidth(line, inner)}
        </Text>
      ))}
    </Box>
  );
}

export function AgentColumn(props: {
  agents: AgentTile[];
  missions: DeckMissionRow[];
  available: boolean;
  reason?: string;
  selectedIndex: number;
  focused: boolean;
  width: number;
  rows: number;
}) {
  const { tr } = useI18n();
  if (!props.available || props.agents.length === 0) {
    return (
      <Box
        flexDirection="column"
        width={props.width}
        height={props.rows}
        borderStyle={props.focused ? 'bold' : 'round'}
        borderColor={props.focused ? theme.focus : theme.muted}
        paddingX={1}
      >
        <Text bold>{tr('deck:agents_title')}</Text>
        <Text color={theme.muted} wrap="wrap">
          {props.available ? tr('deck:agents_none') : tr('deck:agents_unavailable')}
        </Text>
        {!props.available && props.reason ? (
          <Text color={theme.muted} wrap="wrap">
            {props.reason}
          </Text>
        ) : null}
        <Text color={theme.muted} wrap="wrap">
          {tr(props.available ? 'deck:agents_hint_start' : 'deck:agents_hint_unavailable')}
        </Text>
      </Box>
    );
  }
  const perTile = Math.max(5, Math.floor(props.rows / Math.min(props.agents.length, 4)));
  const fit = Math.max(1, Math.floor(props.rows / perTile));
  const start = Math.max(0, Math.min(props.selectedIndex - fit + 1, props.agents.length - fit));
  const missionLabel = (id?: string) =>
    id ? (props.missions.find((m) => m.id === id)?.goal ?? id) : undefined;
  return (
    <Box flexDirection="column" width={props.width} height={props.rows}>
      {props.agents.slice(start, start + fit).map((agent, offset) => (
        <AgentTileView
          key={agent.target}
          agent={agent}
          width={props.width}
          rows={perTile}
          selected={start + offset === props.selectedIndex}
          focused={props.focused}
          missionLabel={missionLabel(agent.missionId)}
        />
      ))}
    </Box>
  );
}

export function AgentGrid(props: {
  agents: AgentTile[];
  missions: DeckMissionRow[];
  available: boolean;
  reason?: string;
  selectedIndex: number;
  cols: number;
  tileWidth: number;
  tileRows: number;
  rows: number;
  width: number;
}) {
  if (!props.available || props.agents.length === 0) {
    return <AgentColumn {...props} focused width={props.width} rows={props.rows} />;
  }
  const rowsOfTiles: AgentTile[][] = [];
  for (let i = 0; i < props.agents.length; i += props.cols) {
    rowsOfTiles.push(props.agents.slice(i, i + props.cols));
  }
  const fitRows = Math.max(1, Math.floor(props.rows / props.tileRows));
  const selectedRow = Math.floor(props.selectedIndex / props.cols);
  const startRow = Math.max(0, Math.min(selectedRow - fitRows + 1, rowsOfTiles.length - fitRows));
  const missionLabel = (id?: string) =>
    id ? (props.missions.find((m) => m.id === id)?.goal ?? id) : undefined;
  return (
    <Box flexDirection="column" height={props.rows}>
      {rowsOfTiles.slice(startRow, startRow + fitRows).map((row, r) => (
        <Box key={r}>
          {row.map((agent, c) => {
            const index = (startRow + r) * props.cols + c;
            return (
              <AgentTileView
                key={agent.target}
                agent={agent}
                width={props.tileWidth}
                rows={props.tileRows}
                selected={index === props.selectedIndex}
                focused
                missionLabel={missionLabel(agent.missionId)}
              />
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

export function MissionDetailView(props: {
  mission?: DeckMissionRow;
  detail?: MissionDetail | null;
  agents: AgentTile[];
  width: number;
  rows: number;
  focused: boolean;
}) {
  const { tr } = useI18n();
  const m = props.mission;
  const d = props.detail;
  const frame = (children: React.ReactNode) => (
    <Box
      flexDirection="column"
      width={props.width}
      height={props.rows}
      borderStyle={props.focused ? 'bold' : 'round'}
      borderColor={props.focused ? theme.focus : theme.muted}
      paddingX={1}
      overflow="hidden"
    >
      {children}
    </Box>
  );
  if (!m) return frame(<Text color={theme.muted}>{tr('deck:detail_select')}</Text>);
  const inner = Math.max(10, props.width - 4);
  const tasks = d?.tasks ?? [];
  const done = tasks.filter((task) => task.status === 'completed').length;
  return frame(
    <>
      <Text bold wrap="truncate-end">
        {m.goal || m.id}
      </Text>
      {d ? <PhaseStrip phase={d.phase} /> : <Text color={theme.muted}>{tr('deck:loading')}</Text>}
      {d?.successCondition ? (
        <Text wrap="truncate-end">
          <Text color={theme.muted}>{tr('deck:detail_success')}: </Text>
          {d.successCondition}
        </Text>
      ) : null}
      <Text> </Text>
      <Text bold>
        {tr('deck:detail_progress')}{' '}
        <Text color={theme.muted}>{tasks.length ? `${done}/${tasks.length}` : ''}</Text>
      </Text>
      {tasks.slice(0, Math.max(3, props.rows - 16)).map((task) => {
        const g = taskGlyph(task.status);
        return (
          <Box key={task.id}>
            <Text color={g.color}>{g.glyph} </Text>
            <Text wrap="truncate-end">
              {fitWidth(task.title || task.id, Math.max(8, inner - 4))}
            </Text>
          </Box>
        );
      })}
      {d?.evidence.length ? (
        <>
          <Text bold>{tr('deck:detail_evidence')}</Text>
          {d.evidence.slice(-4).map((file) => (
            <Text key={file} color={theme.muted} wrap="truncate-end">
              ▤ {artifactTitle(file)}
            </Text>
          ))}
        </>
      ) : null}
      {props.agents.length ? (
        <>
          <Text bold>{tr('deck:detail_agents')}</Text>
          {props.agents.map((agent) => (
            <Text key={agent.target} wrap="truncate-end">
              <Text color={AGENT_COLOR[agent.state]}>{AGENT_GLYPH[agent.state]}</Text>{' '}
              {agentLabel(agent)}
            </Text>
          ))}
        </>
      ) : null}
      {d?.context.length ? (
        <Text color={theme.muted} wrap="truncate-end">
          {d.context
            .map((entry) => `${tr(`deck:context_${entry.label}` as VocabularyKey)}: ${entry.value}`)
            .join('  ·  ')}
        </Text>
      ) : null}
      {d?.nextAction ? (
        <Text wrap="truncate-end">
          <Text color={theme.accent}>→ </Text>
          {d.nextAction}
        </Text>
      ) : null}
    </>
  );
}

export function Conversation(props: {
  transcript: Turn[];
  decisions: DecisionItem[];
  busy: boolean;
  width: number;
  rows: number;
  focused: boolean;
  nextAction?: { title: string; reason?: string; command?: string };
}) {
  const { tr } = useI18n();
  const inner = Math.max(10, props.width - 4);
  const decisionsById = new Map(props.decisions.map((d) => [d.id, d]));
  // Render newest turns that fit; cards count ~7 rows, text turns by wraps.
  const budget = Math.max(3, props.rows - 2);
  const items: React.ReactNode[] = [];
  // a / d act on the newest pending card (controller.selection); mark it.
  const activeDecisionId = [...props.transcript]
    .reverse()
    .find((t) => t.decisionId && decisionsById.has(t.decisionId))?.decisionId;
  let used = 0;
  for (let i = props.transcript.length - 1; i >= 0 && used < budget; i -= 1) {
    const turn = props.transcript[i]!;
    const decision = turn.decisionId ? decisionsById.get(turn.decisionId) : undefined;
    if (turn.decisionId && !decision) continue; // decided/expired: card disappears
    if (decision) {
      if (used + 7 > budget) break;
      used += 7;
      items.unshift(
        <DecisionCard
          key={`${turn.at}-${i}`}
          decision={decision}
          width={inner}
          compact
          active={decision.id === activeDecisionId}
        />
      );
      continue;
    }
    const lines = turn.text.split('\n');
    const cost =
      lines.reduce(
        (sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(10, inner - 6))),
        0
      ) + (turn.intent ? 1 : 0);
    if (used + cost > budget && items.length > 0) break;
    used += cost;
    const color = turn.who === 'you' ? theme.you : turn.who === 'kyb' ? theme.kyb : theme.muted;
    const label = turn.who === 'you' ? tr('deck:who_you') : turn.who === 'kyb' ? 'kyb' : '•';
    items.unshift(
      <Box key={`${turn.at}-${i}`} flexDirection="column">
        <Box>
          <Box width={5} flexShrink={0}>
            <Text color={color} bold>
              {label}
            </Text>
          </Box>
          <Box width={inner - 5}>
            <Text wrap="wrap">{turn.text}</Text>
          </Box>
        </Box>
        {turn.intent ? (
          <Box marginLeft={5}>
            <Text color={theme.muted} wrap="truncate-end">
              {[
                turn.intent.understood &&
                  `${tr('deck:intent_understood')}: ${humanize(turn.intent.understood)}`,
                turn.intent.shape &&
                  `${tr('deck:intent_shape')}: ${shapeLabel(turn.intent.shape, tr)}`,
                turn.intent.next && `${tr('deck:intent_next')}: ${turn.intent.next}`,
              ]
                .filter(Boolean)
                .join('  ·  ')}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      width={props.width}
      height={props.rows}
      borderStyle={props.focused ? 'bold' : 'round'}
      borderColor={props.focused ? theme.focus : theme.muted}
      paddingX={1}
      justifyContent="flex-end"
      overflow="hidden"
    >
      {items.length === 0 ? (
        <Box flexDirection="column">
          <Text bold>{tr('deck:welcome_title')}</Text>
          <Text color={theme.muted} wrap="wrap">
            {tr('deck:welcome_body')}
          </Text>
          {props.nextAction ? (
            <Text wrap="wrap">
              <Text color={theme.accent}>→ </Text>
              {props.nextAction.title}
              {props.nextAction.reason ? (
                <Text color={theme.muted}> — {props.nextAction.reason}</Text>
              ) : null}
            </Text>
          ) : null}
        </Box>
      ) : (
        items
      )}
      {props.busy ? <Text color={theme.kyb}>kyb {tr('deck:thinking')}</Text> : null}
    </Box>
  );
}
