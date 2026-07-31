import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { usePollWatch } from '../store/use-poll-watch.js';
import {
  loadCoordination,
  coordinationViewModel,
  coordinationWatchPaths,
} from '../store/coordination.js';
import { restartRuntime, stopRuntime, ensureSupervisorDaemon } from '../actions/runtime-actions.js';
import { PanelView } from '../components/panel-view.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { usePanelActions } from './use-actions.js';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';
import type { PanelProps } from './common.js';

export function CoordinationPanel({ isActive, refreshNonce }: PanelProps) {
  const i18n = useI18n();
  const { data, loading, error, refresh } = usePollWatch({
    load: loadCoordination,
    watchPaths: coordinationWatchPaths(),
    intervalMs: 10000,
    refreshNonce,
  });
  const actions = usePanelActions(refresh);
  const vm = useMemo(() => {
    if (!data) return undefined;
    const model = coordinationViewModel(data, i18n);
    model.footerHint = [
      `R ${i18n.tr('tui:tui_coord_action_restart')}`,
      `X ${i18n.tr('tui:tui_process_action_stop')}`,
      'E daemon',
    ].join(' · ');
    return model;
  }, [data, i18n]);

  return (
    <Box flexDirection="column">
      <PanelView
        vm={vm}
        loading={loading}
        error={error}
        isActive={isActive && !actions.confirm && !actions.busy}
        onAction={(input, rowId) => {
          if (input === 'E') {
            actions.request(
              () => ensureSupervisorDaemon(),
              `${i18n.tr('tui:tui_coord_daemon_offline')}`
            );
            return true;
          }
          if (!rowId) return false;
          const snapshot = data?.runtimes?.find((runtime) => runtime.agent_id === rowId);
          if (!snapshot) return false;
          if (input === 'R') {
            actions.request(
              () => restartRuntime(snapshot),
              `${i18n.tr('tui:tui_coord_action_restart')}: ${rowId}?`
            );
            return true;
          }
          if (input === 'X') {
            actions.request(
              () => stopRuntime(rowId),
              `${i18n.tr('tui:tui_process_action_stop')}: ${rowId}?`
            );
            return true;
          }
          return false;
        }}
      />
      {actions.confirm ? (
        <ConfirmDialog message={actions.confirm.message} onDecision={actions.decide} />
      ) : null}
      {actions.status ? <Text color={theme.dim}>{actions.status}</Text> : null}
    </Box>
  );
}
