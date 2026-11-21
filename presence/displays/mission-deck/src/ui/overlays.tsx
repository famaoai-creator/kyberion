import { Box } from 'ink';
import TextInput from 'ink-text-input';
import { Text } from './text.js';
import { useI18n } from '../i18n.js';
import { fitWidth } from '../model/layout.js';
import type { AgentTile } from '../model/types.js';
import { AGENT_COLOR, AGENT_GLYPH, theme } from './theme.js';
import { sanitizeTerminalText } from './terminal-text.js';
import type { VocabularyKey } from '@agent/core/t';

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
}

export function filterPalette(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (command) =>
      command.label.toLowerCase().includes(q) ||
      command.id.toLowerCase().includes(q) ||
      (command.hint ?? '').toLowerCase().includes(q)
  );
}

function Frame(props: { width: number; title: string; children: React.ReactNode; color?: string }) {
  return (
    <Box
      flexDirection="column"
      width={props.width}
      borderStyle="double"
      borderColor={props.color ?? theme.focus}
      paddingX={1}
    >
      <Text bold color={props.color ?? theme.focus}>
        {props.title}
      </Text>
      {props.children}
    </Box>
  );
}

export const HELP_KEYS: { keys: string; label: VocabularyKey }[] = [
  { keys: '1 2 3', label: 'deck:help_views' },
  { keys: 'Tab / Shift+Tab', label: 'deck:help_focus' },
  { keys: 'j k ↑ ↓', label: 'deck:help_move' },
  { keys: 'i  /', label: 'deck:help_compose' },
  { keys: 'Esc', label: 'deck:help_escape' },
  { keys: 'Space', label: 'deck:help_peek' },
  { keys: 'Enter', label: 'deck:help_enter' },
  { keys: 'a  d', label: 'deck:help_decide' },
  { keys: 's', label: 'deck:help_steer' },
  { keys: '!', label: 'deck:help_interrupt' },
  { keys: 'p', label: 'deck:help_pause' },
  { keys: 'g', label: 'deck:help_goto_decision' },
  { keys: 'r', label: 'deck:help_refresh' },
  { keys: 'L', label: 'deck:help_locale' },
  { keys: 'Ctrl+P', label: 'deck:help_palette' },
  { keys: 'q', label: 'deck:help_quit' },
];

export function HelpOverlay({ width }: { width: number }) {
  const { tr } = useI18n();
  return (
    <Frame width={width} title={tr('deck:help_title')}>
      {HELP_KEYS.map((entry) => (
        <Box key={entry.keys}>
          <Box width={18}>
            <Text bold>{entry.keys}</Text>
          </Box>
          <Text wrap="truncate-end">{tr(entry.label)}</Text>
        </Box>
      ))}
      <Text color={theme.muted} wrap="wrap">
        {tr('deck:help_legend')}
      </Text>
      <Text color={theme.muted}>{tr('deck:help_focus_marker')}</Text>
      <Text color={theme.muted}>{tr('deck:overlay_close')}</Text>
    </Frame>
  );
}

export function PaletteOverlay(props: {
  width: number;
  query: string;
  index: number;
  commands: PaletteCommand[];
  onChange: (query: string) => void;
  onSubmit: () => void;
}) {
  const { tr } = useI18n();
  const matches = filterPalette(props.commands, props.query);
  return (
    <Frame width={props.width} title={tr('deck:palette_title')}>
      <Box>
        <Text color={theme.focus}>{'⌕ '}</Text>
        <TextInput
          value={props.query}
          onChange={(value) => props.onChange(sanitizeTerminalText(value))}
          onSubmit={props.onSubmit}
        />
      </Box>
      {matches.slice(0, 10).map((command, i) => (
        <Text
          key={command.id}
          {...(i === props.index ? { inverse: true } : {})}
          wrap="truncate-end"
        >
          {i === props.index ? '▸ ' : '  '}
          {command.label}
          {command.hint ? <Text color={theme.muted}> {command.hint}</Text> : null}
        </Text>
      ))}
      {matches.length === 0 ? <Text color={theme.muted}>{tr('deck:palette_empty')}</Text> : null}
    </Frame>
  );
}

export function PeekOverlay(props: {
  width: number;
  rows: number;
  agent?: AgentTile;
  draft: string;
  onChange: (draft: string) => void;
  onSubmit: (draft: string) => void;
}) {
  const { tr } = useI18n();
  const a = props.agent;
  if (!a) {
    return (
      <Frame width={props.width} title={tr('deck:peek_title')}>
        <Text color={theme.muted}>{tr('deck:peek_gone')}</Text>
      </Frame>
    );
  }
  const inner = Math.max(10, props.width - 4);
  return (
    <Frame
      width={props.width}
      color={AGENT_COLOR[a.state]}
      title={`${AGENT_GLYPH[a.state]} ${a.provider ? `${a.provider} · ` : ''}${a.name}`}
    >
      {a.tail.slice(-Math.max(3, props.rows - 6)).map((line, index) => (
        <Text key={index} wrap="truncate-end">
          {fitWidth(line, inner)}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={theme.focus}>{tr('deck:peek_reply')} › </Text>
        <TextInput
          value={props.draft}
          onChange={(value) => props.onChange(sanitizeTerminalText(value))}
          onSubmit={props.onSubmit}
        />
      </Box>
      <Text color={theme.muted}>{tr('deck:peek_hint')}</Text>
    </Frame>
  );
}

export function SteerOverlay(props: {
  width: number;
  title: string;
  draft: string;
  onChange: (draft: string) => void;
  onSubmit: (draft: string) => void;
}) {
  const { tr } = useI18n();
  return (
    <Frame width={props.width} title={props.title}>
      <Text color={theme.muted} wrap="wrap">
        {tr('deck:steer_explain')}
      </Text>
      <Box>
        <Text color={theme.focus}>› </Text>
        <TextInput
          value={props.draft}
          onChange={(value) => props.onChange(sanitizeTerminalText(value))}
          onSubmit={props.onSubmit}
        />
      </Box>
      <Text color={theme.muted}>{tr('deck:steer_hint')}</Text>
    </Frame>
  );
}

export function ConfirmOverlay(props: { width: number; text: string }) {
  const { tr } = useI18n();
  return (
    <Frame width={props.width} title={tr('deck:confirm_title')} color={theme.warn}>
      <Text wrap="wrap">{props.text}</Text>
      <Text>
        <Text color={theme.ok} bold>
          [y] {tr('deck:confirm_yes')}
        </Text>
        {'   '}
        <Text color={theme.muted}>[n / Esc] {tr('deck:confirm_no')}</Text>
      </Text>
    </Frame>
  );
}
