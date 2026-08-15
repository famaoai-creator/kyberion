import { Box, Text } from 'ink';
import { GLOBAL_HELP, type HelpRow } from '../keymap.js';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';

export interface HelpOverlayProps {
  panelHelp?: HelpRow[];
}

export function HelpOverlay({ panelHelp }: HelpOverlayProps) {
  const { tr } = useI18n();
  const rows = [...GLOBAL_HELP, ...(panelHelp ?? [])];
  return (
    <Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1}>
      <Text bold color={theme.accent}>
        {tr('tui:tui_help_title')}
      </Text>
      {rows.map((row, idx) => (
        <Box key={`${row.keys}:${row.labelKey}:${idx}`}>
          <Box width={12}>
            <Text color={theme.warn}>{row.keys}</Text>
          </Box>
          <Text>{tr(row.labelKey)}</Text>
        </Box>
      ))}
    </Box>
  );
}
