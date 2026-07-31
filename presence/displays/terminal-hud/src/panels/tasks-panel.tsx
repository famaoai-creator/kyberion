import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { usePollWatch } from '../store/use-poll-watch.js';
import { loadWork, workViewModel, workWatchPaths } from '../store/work.js';
import { claimItem, releaseItem, advanceItemStatus } from '../actions/work-actions.js';
import { PanelView } from '../components/panel-view.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { usePanelActions } from './use-actions.js';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';
import type { PanelProps } from './common.js';

export function TasksPanel({ isActive, refreshNonce }: PanelProps) {
  const i18n = useI18n();
  const { data, loading, error, refresh } = usePollWatch({
    load: loadWork,
    watchPaths: workWatchPaths(),
    refreshNonce,
  });
  const actions = usePanelActions(refresh);
  const vm = useMemo(() => {
    if (!data) return undefined;
    const model = workViewModel(data, i18n);
    model.footerHint = [
      `c ${i18n.tr('tui:tui_task_action_claim')}`,
      `x ${i18n.tr('tui:tui_task_action_release')}`,
      `s ${i18n.tr('tui:tui_task_action_status')}`,
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
          if (!rowId) return false;
          if (input === 'c') {
            actions.request(() => claimItem(rowId));
            return true;
          }
          if (input === 'x') {
            actions.request(() => releaseItem(rowId));
            return true;
          }
          if (input === 's') {
            actions.request(() => advanceItemStatus(rowId));
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
