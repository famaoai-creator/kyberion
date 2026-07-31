import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { usePollWatch } from '../store/use-poll-watch.js';
import { loadSchedules, schedulesViewModel, schedulesWatchPaths } from '../store/schedules.js';
import { toggleSchedule, removeSchedule, runScheduleNow } from '../actions/schedule-actions.js';
import { PanelView } from '../components/panel-view.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { usePanelActions } from './use-actions.js';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';
import type { PanelProps } from './common.js';

export function SchedulesPanel({ isActive, refreshNonce }: PanelProps) {
  const i18n = useI18n();
  const { data, loading, error, refresh } = usePollWatch({
    load: loadSchedules,
    watchPaths: schedulesWatchPaths(),
    refreshNonce,
  });
  const actions = usePanelActions(refresh);
  const vm = useMemo(() => {
    if (!data) return undefined;
    const model = schedulesViewModel(data, i18n);
    model.footerHint = [
      `e on/off`,
      `R ${i18n.tr('tui:tui_schedule_action_run')}`,
      `x ${i18n.tr('tui:tui_schedule_action_remove')}`,
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
          if (input === 'e') {
            actions.request(() => toggleSchedule(rowId));
            return true;
          }
          if (input === 'R') {
            actions.request(
              () => runScheduleNow(rowId),
              `${i18n.tr('tui:tui_schedule_action_run')}: ${rowId}?`
            );
            return true;
          }
          if (input === 'x') {
            actions.request(
              () => removeSchedule(rowId),
              `${i18n.tr('tui:tui_schedule_action_remove')}: ${rowId}?`
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
