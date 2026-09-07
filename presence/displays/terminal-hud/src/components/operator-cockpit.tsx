import { Box, Text } from 'ink';
import type { IntentResolutionContract } from '@agent/core/intent-resolution-contract';
import type { OperatorHomeSummary } from '@agent/core/operator-home-summary';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';
import { IntentPreview } from './intent-preview.js';
import type { VoiceState } from './input-bar.js';

export interface OperatorCockpitAgentsWaiting {
  waiting: number;
  humansWaitedOn: number;
}

export interface OperatorCockpitProps {
  summary?: OperatorHomeSummary;
  loading: boolean;
  error?: string;
  intentPreview?: IntentResolutionContract;
  backend?: string;
  customer?: string;
  tenant?: string;
  voiceState?: VoiceState;
  /** AC-05: collaboration-tree "who is waiting" summary; absent when unavailable. */
  agentsWaiting?: OperatorCockpitAgentsWaiting;
}

function statusColor(status?: OperatorHomeSummary['status']): string {
  if (status === 'blocked') return theme.err;
  if (status === 'attention') return theme.warn;
  return theme.ok;
}

export function OperatorCockpit({
  summary,
  loading,
  error,
  intentPreview,
  backend,
  customer,
  tenant,
  voiceState,
  agentsWaiting,
}: OperatorCockpitProps) {
  const { tr } = useI18n();
  const scope = tenant
    ? tr('tui:tui_cockpit_scope_tenant', { tenant })
    : tr('tui:tui_cockpit_scope_unconfigured');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.accent}>
          {tr('tui:tui_cockpit_title')}
        </Text>
        <Text dimColor>
          {backend || 'auto'} · {customer || '-'}
        </Text>
      </Box>
      {agentsWaiting && (agentsWaiting.waiting > 0 || agentsWaiting.humansWaitedOn > 0) ? (
        <Text color={theme.warn}>
          {tr('tui:tui_home_agents_waiting', {
            waiting: agentsWaiting.waiting,
            humans: agentsWaiting.humansWaitedOn,
          })}
        </Text>
      ) : null}
      {loading && !summary ? <Text dimColor>{tr('tui:tui_loading')}</Text> : null}
      {error ? (
        <Text color={theme.err}>
          {tr('tui:tui_error')}: {error}
        </Text>
      ) : null}
      {summary ? (
        <>
          <Text color={statusColor(summary.status)}>
            ● {summary.statusLabel} · {summary.statusDetail}
          </Text>
          <Text dimColor>
            {tr('tui:tui_cockpit_active')}: {summary.counts.activeMissions} ·{' '}
            {tr('tui:tui_cockpit_blocked')}: {summary.counts.blockedMissions} ·{' '}
            {tr('tui:tui_cockpit_approvals')}: {summary.counts.pendingApprovals} ·{' '}
            {tr('tui:tui_cockpit_inbox')}: {summary.counts.unreadInbox}
          </Text>
          <Text>
            <Text bold color={theme.warn}>
              {tr('tui:tui_cockpit_next')}:{' '}
            </Text>
            {summary.nextAction.title}
            <Text dimColor> — {summary.nextAction.reason}</Text>
          </Text>
          {summary.actionQueue && summary.actionQueue.length > 0 ? (
            <Text dimColor>
              {tr('tui:tui_cockpit_attention')}: {summary.actionQueue[0].title} →{' '}
              {summary.actionQueue[0].nextAction}
            </Text>
          ) : null}
        </>
      ) : null}
      <Text dimColor>
        {tr('tui:tui_cockpit_scope')}: {tr('tui:tui_cockpit_scope_local')} · {scope}
      </Text>
      {voiceState === 'recording' ? (
        <Text color={theme.err}>{tr('tui:tui_cockpit_voice_recording')}</Text>
      ) : voiceState === 'transcribing' ? (
        <Text color={theme.warn}>{tr('tui:tui_cockpit_voice_transcribing')}</Text>
      ) : (
        <Text dimColor>{tr('tui:tui_cockpit_voice_hint')}</Text>
      )}
      {intentPreview ? <IntentPreview contract={intentPreview} /> : null}
    </Box>
  );
}
