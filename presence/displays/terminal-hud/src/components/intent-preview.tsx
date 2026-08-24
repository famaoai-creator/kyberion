import { Box, Text } from 'ink';
import type { IntentResolutionContract } from '@agent/core';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';
import { intentAuthorityVocabularyKey } from './intent-preview-model.js';

export interface IntentPreviewProps {
  contract: IntentResolutionContract;
}

export function IntentPreview({ contract }: IntentPreviewProps) {
  const { tr } = useI18n();
  const authorityKey = intentAuthorityVocabularyKey(contract.authority_level);
  const authorityColor =
    contract.authority_level === 'approval_required'
      ? theme.warn
      : contract.authority_level === 'human_clarification_required'
        ? theme.err
        : theme.ok;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1}>
      <Text bold color={theme.accent}>
        {tr('tui:tui_cockpit_intent_preview')}
      </Text>
      <Text>
        <Text dimColor>{tr('tui:tui_cockpit_intent')}: </Text>
        {contract.normalized_intent}
        <Text dimColor>
          {' · '}
          {tr('tui:tui_cockpit_shape')}: {contract.resolution_shape}
          {' · '}
          {tr('tui:tui_cockpit_outcome')}: {contract.outcome_kind}
        </Text>
      </Text>
      <Text color={authorityColor}>
        {tr('tui:tui_cockpit_authority')}: {tr(authorityKey)}
      </Text>
      {contract.missing_inputs.length > 0 ? (
        <Text color={theme.warn}>
          {tr('tui:tui_cockpit_missing')}: {contract.missing_inputs.join(', ')}
        </Text>
      ) : null}
    </Box>
  );
}
