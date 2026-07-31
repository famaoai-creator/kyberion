import { Box, Text } from 'ink';
import { PANELS, PANEL_LABEL_KEYS, type PanelId } from '../keymap.js';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';

export interface TabBarProps {
  active: PanelId;
}

export function TabBar({ active }: TabBarProps) {
  const { tr } = useI18n();
  return (
    <Box>
      {PANELS.map((panel, idx) => {
        const isActive = panel === active;
        return (
          <Box key={panel} marginRight={1}>
            <Text
              color={isActive ? 'black' : theme.dim}
              backgroundColor={isActive ? theme.accent : undefined}
              bold={isActive}
            >
              {` ${idx + 1} ${tr(PANEL_LABEL_KEYS[panel])} `}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
