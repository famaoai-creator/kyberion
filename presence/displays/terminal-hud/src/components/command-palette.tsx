import { useMemo, useState } from 'react';
import { Box, useInput, useStdin, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { Text } from './text.js';
import { useI18n } from '../i18n.js';
import { sanitizeTerminalText } from '../terminal-text.js';
import { theme } from '../theme.js';
import {
  filterPalette,
  navigationPalette,
  type PaletteSelection,
} from './command-palette-model.js';

export interface CommandPaletteProps {
  onSelect: (selection: PaletteSelection) => void;
  onCancel: () => void;
}

export function CommandPalette({ onSelect, onCancel }: CommandPaletteProps) {
  const i18n = useI18n();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const catalog = useMemo(() => navigationPalette(i18n), [i18n]);
  const matches = useMemo(() => filterPalette(catalog, query), [catalog, query]);
  const selected = Math.min(selectedIndex, Math.max(0, matches.length - 1));
  const visibleCount = Math.max(3, Math.min(8, (stdout?.rows ?? 24) - 18));
  const start = Math.max(0, selected - visibleCount + 1);

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input.toLowerCase() === 'p')) {
        onCancel();
      } else if (key.downArrow) {
        setSelectedIndex((index) => Math.min(index + 1, Math.max(0, matches.length - 1)));
      } else if (key.upArrow) {
        setSelectedIndex((index) => Math.max(0, index - 1));
      }
    },
    { isActive: isRawModeSupported }
  );

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={theme.accent} paddingX={1}>
      <Text bold color={theme.accent}>
        {i18n.tr('tui:tui_key_palette')}
      </Text>
      <Box>
        <Text color={theme.accent}>❯ </Text>
        <TextInput
          value={sanitizeTerminalText(query)}
          onChange={(value) => {
            setQuery(value);
            setSelectedIndex(0);
          }}
          onSubmit={() => {
            if (matches[selected]) onSelect(matches[selected].selection);
          }}
          placeholder={i18n.tr('tui:tui_palette_search')}
        />
      </Box>
      {matches.length === 0 ? <Text dimColor>{i18n.tr('tui:tui_empty')}</Text> : null}
      {matches.slice(start, start + visibleCount).map((entry, index) => (
        <Text
          key={entry.id}
          color={start + index === selected ? 'black' : undefined}
          backgroundColor={start + index === selected ? theme.accent : undefined}
        >
          {start + index === selected ? '› ' : '  '}
          {entry.category} · {entry.label}
        </Text>
      ))}
      <Text dimColor>
        {matches.length ? `${selected + 1}/${matches.length} · ` : ''}
        {i18n.tr('tui:tui_palette_hint')}
      </Text>
    </Box>
  );
}
