import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';

export type VoiceState = 'recording' | 'transcribing' | undefined;

export interface InputBarProps {
  focused: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  busy: boolean;
  voiceState?: VoiceState;
}

export function InputBar({ focused, value, onChange, onSubmit, busy, voiceState }: InputBarProps) {
  const { tr } = useI18n();
  const marker = voiceState === 'recording' ? '●' : voiceState === 'transcribing' ? '◌' : '❯';
  const markerColor =
    voiceState === 'recording'
      ? theme.err
      : voiceState === 'transcribing'
        ? theme.warn
        : theme.accent;
  return (
    <Box borderStyle="round" borderColor={focused ? theme.accent : theme.dim} paddingX={1}>
      <Text color={markerColor}>{marker} </Text>
      {busy ? (
        <Text dimColor>{tr('tui:tui_input_thinking')}</Text>
      ) : voiceState === 'recording' ? (
        <Text color={theme.err}>{tr('tui:tui_voice_recording')}</Text>
      ) : voiceState === 'transcribing' ? (
        <Text color={theme.warn}>{tr('tui:tui_voice_transcribing')}</Text>
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={focused}
          placeholder={tr('tui:tui_input_placeholder')}
        />
      )}
      <Text dimColor> · {tr('tui:tui_cockpit_input_hint')}</Text>
    </Box>
  );
}
