import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { usePollWatch } from '../store/use-poll-watch.js';
import {
  loadMissions,
  missionsViewModel,
  missionsWatchPaths,
  missionDetail,
} from '../store/missions.js';
import {
  runMissionAction,
  MISSION_ACTION_KEYS,
  MISSION_CONFIRM_ACTIONS,
} from '../actions/mission-actions.js';
import { PanelView } from '../components/panel-view.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { usePanelActions } from './use-actions.js';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';
import type { PanelProps } from './common.js';

export function MissionsPanel({ isActive, refreshNonce }: PanelProps) {
  const i18n = useI18n();
  const { data, loading, error, refresh } = usePollWatch({
    load: loadMissions,
    watchPaths: missionsWatchPaths(),
    refreshNonce,
  });
  const actions = usePanelActions(refresh);
  const vm = useMemo(() => {
    if (!data) return undefined;
    const model = missionsViewModel(data, i18n);
    model.footerHint = [
      `s ${i18n.tr('tui:tui_mission_action_start')}`,
      `p ${i18n.tr('tui:tui_mission_action_pause')}`,
      `u ${i18n.tr('tui:tui_mission_action_resume')}`,
      `c ${i18n.tr('tui:tui_mission_action_checkpoint')}`,
      `V ${i18n.tr('tui:tui_mission_action_verify')}`,
      `F ${i18n.tr('tui:tui_mission_action_finish')}`,
      `X ${i18n.tr('tui:tui_mission_action_cancel')}`,
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
        detailFor={(id) => missionDetail(id, i18n)}
        onAction={(input, rowId) => {
          const kind = MISSION_ACTION_KEYS[input];
          if (!kind || !rowId) return false;
          const confirmMessage = MISSION_CONFIRM_ACTIONS.has(kind)
            ? kind === 'finish'
              ? i18n.tr('tui:tui_mission_confirm_finish', { id: rowId })
              : kind === 'cancel'
                ? i18n.tr('tui:tui_mission_confirm_cancel', { id: rowId })
                : `${i18n.tr('tui:tui_mission_action_verify')}: ${rowId}?`
            : undefined;
          actions.request(() => runMissionAction(kind, rowId), confirmMessage);
          return true;
        }}
      />
      {actions.confirm ? (
        <ConfirmDialog message={actions.confirm.message} onDecision={actions.decide} />
      ) : null}
      {actions.status ? <Text color={theme.dim}>{actions.status}</Text> : null}
    </Box>
  );
}
