import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { usePollWatch } from '../store/use-poll-watch.js';
import {
  loadProcesses,
  processesViewModel,
  processesWatchPaths,
  processDetail,
} from '../store/processes.js';
import { runSurfaceAction } from '../actions/surface-actions.js';
import { PanelView } from '../components/panel-view.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { usePanelActions } from './use-actions.js';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';
import type { PanelProps } from './common.js';

export function ProcessesPanel({ isActive, refreshNonce }: PanelProps) {
  const i18n = useI18n();
  const { data, loading, error, refresh } = usePollWatch({
    load: loadProcesses,
    watchPaths: processesWatchPaths(),
    refreshNonce,
  });
  const actions = usePanelActions(refresh);
  const vm = useMemo(() => {
    if (!data) return undefined;
    const model = processesViewModel(data, i18n);
    model.footerHint = [
      `s ${i18n.tr('tui:tui_process_action_start')}`,
      `x ${i18n.tr('tui:tui_process_action_stop')}`,
      `R repair`,
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
        detailFor={(id) => {
          const row = data?.processes.find((process) => process.id === id);
          return row ? processDetail(row, i18n) : undefined;
        }}
        onAction={(input, rowId) => {
          if (!rowId) return false;
          if (input === 's') {
            actions.request(() => runSurfaceAction('start', rowId));
            return true;
          }
          if (input === 'x') {
            actions.request(
              () => runSurfaceAction('stop', rowId),
              `${i18n.tr('tui:tui_process_action_stop')}: ${rowId}?`
            );
            return true;
          }
          if (input === 'R') {
            actions.request(() => runSurfaceAction('repair', rowId));
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
