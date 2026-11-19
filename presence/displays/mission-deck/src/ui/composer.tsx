import { useMemo } from 'react';
import { Box } from 'ink';
import TextInput from 'ink-text-input';
import { Text } from './text.js';
import { useI18n } from '../i18n.js';
import { theme } from './theme.js';
import { humanize, outcomeLabel, shapeLabel } from './labels.js';
import { sanitizeTerminalText } from './terminal-text.js';
import type { Toast } from '../store/deck-store.js';
import {
  resolveIntentResolutionContract,
  type IntentResolutionContract,
} from '@agent/core/intent/intent-resolution-contract';

export interface IntentPreviewModel {
  understood: string;
  shape: string;
  returns?: string;
  missing: string[];
  next?: string;
}

export function previewIntent(
  draft: string,
  options: { tier?: string; tenantId?: string } = {},
  resolve: typeof resolveIntentResolutionContract = resolveIntentResolutionContract
): IntentPreviewModel | undefined {
  const text = draft.trim();
  if (!text || text.startsWith(':')) return undefined;
  let contract: IntentResolutionContract;
  try {
    contract = resolve(text, options as Parameters<typeof resolveIntentResolutionContract>[1]);
  } catch {
    return undefined;
  }
  const loose = contract as unknown as {
    normalized_intent?: string;
    resolution_shape?: string;
    outcome_kind?: string;
    missing_inputs?: string[];
    next_action?: { label?: string };
  };
  return {
    understood: loose.normalized_intent ?? text,
    shape: loose.resolution_shape ?? '',
    returns: loose.outcome_kind,
    missing: loose.missing_inputs ?? [],
    next: loose.next_action?.label,
  };
}

export function Composer(props: {
  value: string;
  focused: boolean;
  busy: boolean;
  width: number;
  scope: { tier?: string; tenantId?: string };
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const { tr } = useI18n();
  const preview = useMemo(
    () => (props.focused ? previewIntent(props.value, props.scope) : undefined),
    [props.value, props.focused, props.scope]
  );
  return (
    <Box flexDirection="column" width={props.width}>
      <Box>
        <Text color={props.focused ? theme.focus : theme.muted} bold>
          {'› '}
        </Text>
        {props.focused ? (
          <TextInput
            value={props.value}
            onChange={(value) => props.onChange(sanitizeTerminalText(value))}
            onSubmit={props.onSubmit}
            placeholder={tr('deck:composer_placeholder')}
          />
        ) : (
          <Text color={theme.muted} wrap="truncate-end">
            {props.value || tr('deck:composer_unfocused')}
          </Text>
        )}
      </Box>
      <Text color={theme.muted} wrap="truncate-end">
        {preview
          ? [
              `${tr('deck:intent_understood')}: ${humanize(preview.understood)}`,
              preview.shape && `${tr('deck:intent_shape')}: ${shapeLabel(preview.shape, tr)}`,
              preview.returns &&
                `${tr('deck:intent_returns')}: ${outcomeLabel(preview.returns, tr)}`,
              preview.missing.length
                ? `${tr('deck:intent_missing')}: ${preview.missing.map(humanize).join(', ')}`
                : '',
              preview.next && `${tr('deck:intent_next')}: ${preview.next}`,
            ]
              .filter(Boolean)
              .join('  ·  ')
          : props.busy
            ? tr('deck:composer_busy')
            : ' '}
      </Text>
    </Box>
  );
}

export function Footer(props: { hints: string; toast?: Toast; width: number }) {
  const showToast = props.toast && Date.now() - props.toast.at < 8000;
  return (
    <Box width={props.width}>
      {showToast ? (
        <Text color={props.toast!.ok ? theme.ok : theme.danger} wrap="truncate-end">
          {props.toast!.ok ? '✓ ' : '✗ '}
          {props.toast!.text}
        </Text>
      ) : (
        <Text color={theme.muted} wrap="truncate-end">
          {props.hints}
        </Text>
      )}
    </Box>
  );
}
