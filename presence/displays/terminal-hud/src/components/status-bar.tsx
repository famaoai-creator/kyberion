import { Box, Text } from 'ink';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';

export interface StatusBarProps {
  backend?: string;
  customer?: string;
  daemonsOnline?: number;
  daemonsTotal?: number;
  message?: string;
}

export function StatusBar({
  backend,
  customer,
  daemonsOnline,
  daemonsTotal,
  message,
}: StatusBarProps) {
  const { tr, locale } = useI18n();
  const daemons =
    daemonsTotal !== undefined
      ? `${tr('tui:tui_status_daemons')} ${daemonsOnline ?? 0}/${daemonsTotal}`
      : undefined;
  const parts = [
    backend ? `${tr('tui:tui_status_backend')} ${backend}` : undefined,
    customer ? `${tr('tui:tui_status_customer')} ${customer}` : undefined,
    daemons,
    `${tr('tui:tui_status_locale')} ${locale}`,
  ].filter((part): part is string => Boolean(part));
  return (
    <Box justifyContent="space-between">
      <Box>
        {message ? (
          <Text color={theme.warn}>{message}</Text>
        ) : (
          <Text dimColor>{parts.join('  ·  ')}</Text>
        )}
      </Box>
      <Text dimColor>{tr('tui:tui_help_hint')}</Text>
    </Box>
  );
}
