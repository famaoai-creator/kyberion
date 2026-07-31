import { Box, Text, useInput, useStdin } from 'ink';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';

export interface ConfirmDialogProps {
  message: string;
  onDecision: (confirmed: boolean) => void;
}

export function ConfirmDialog({ message, onDecision }: ConfirmDialogProps) {
  const { tr } = useI18n();
  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') {
        onDecision(true);
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        onDecision(false);
      }
    },
    { isActive: isRawModeSupported }
  );
  return (
    <Box flexDirection="column" borderStyle="double" borderColor={theme.warn} paddingX={2}>
      <Text bold color={theme.warn}>
        {tr('tui:tui_confirm_title')}
      </Text>
      <Text>{message}</Text>
      <Text dimColor>
        {tr('tui:tui_confirm_yes')} / {tr('tui:tui_confirm_no')}
      </Text>
    </Box>
  );
}
