import { useMemo } from 'react';
import { usePollWatch } from '../store/use-poll-watch.js';
import { loadStats, statsViewModel, statsWatchPaths } from '../store/stats.js';
import { PanelView } from '../components/panel-view.js';
import { useI18n } from '../i18n.js';
import type { PanelProps } from './common.js';

export function StatsPanel({ isActive, refreshNonce }: PanelProps) {
  const i18n = useI18n();
  const { data, loading, error } = usePollWatch({
    load: loadStats,
    watchPaths: statsWatchPaths(),
    intervalMs: 10000,
    refreshNonce,
  });
  const vm = useMemo(() => (data ? statsViewModel(data, i18n) : undefined), [data, i18n]);
  return <PanelView vm={vm} loading={loading} error={error} isActive={isActive} />;
}
