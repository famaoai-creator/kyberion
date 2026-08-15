import { Box, Text } from 'ink';
import { PANEL_LABEL_KEYS, type PanelId } from '../keymap.js';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';

export interface HudHeaderProps {
  active: PanelId;
  daemonsOnline?: number;
  daemonsTotal?: number;
}

/** A small orientation strip: product, current place, and operational health. */
export function HudHeader({ active, daemonsOnline, daemonsTotal }: HudHeaderProps) {
  const { tr } = useI18n();
  const daemonLabel = daemonsTotal === undefined ? '—' : `${daemonsOnline ?? 0}/${daemonsTotal}`;
  const daemonColor =
    daemonsTotal !== undefined && daemonsOnline === daemonsTotal ? theme.ok : theme.warn;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
        justifyContent="space-between"
      >
        <Text>
          <Text bold color={theme.accent}>
            KYBERION
          </Text>
          <Text dimColor> / Terminal HUD</Text>
        </Text>
        <Text color={daemonColor}>
          ● {daemonLabel} {tr('tui:tui_status_daemons')}
        </Text>
      </Box>
      <Box paddingX={2}>
        <Text bold>{tr(PANEL_LABEL_KEYS[active])}</Text>
        <Text dimColor>
          {' '}
          · {tr('tui:tui_key_move')} · {tr('tui:tui_key_detail')}
        </Text>
      </Box>
    </Box>
  );
}
