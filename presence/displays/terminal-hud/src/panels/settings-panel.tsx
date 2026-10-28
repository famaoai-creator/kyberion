import { useMemo } from 'react';
import { usePollWatch } from '../store/use-poll-watch.js';
import { loadSettings, settingsViewModel, settingsWatchPaths } from '../store/settings.js';
import { PanelView } from '../components/panel-view.js';
import { useI18n } from '../i18n.js';
import type { PanelProps } from './common.js';

export function SettingsPanel({ isActive, refreshNonce, pendingApprovals }: PanelProps) {
  const i18n = useI18n();
  const { data, loading, error } = usePollWatch({
    load: loadSettings,
    watchPaths: settingsWatchPaths(),
    intervalMs: 15000,
    refreshNonce,
  });
  const vm = useMemo(
    () => (data ? settingsViewModel({ ...data, approvals: pendingApprovals }, i18n) : undefined),
    [data, i18n, pendingApprovals]
  );
  return <PanelView vm={vm} loading={loading} error={error} isActive={isActive} />;
}
