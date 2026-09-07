import { useMemo } from 'react';
import { Box } from 'ink';
import { usePollWatch } from '../store/use-poll-watch.js';
import { loadAgentGraph, agentGraphViewModel, agentGraphWatchPaths } from '../store/agent-graph.js';
import { PanelView } from '../components/panel-view.js';
import { useI18n } from '../i18n.js';
import type { PanelProps } from './common.js';

export function AgentGraphPanel({ isActive, refreshNonce }: PanelProps) {
  const i18n = useI18n();
  const { data, loading, error } = usePollWatch({
    load: loadAgentGraph,
    watchPaths: agentGraphWatchPaths(),
    intervalMs: 5000,
    refreshNonce,
  });
  const vm = useMemo(() => (data ? agentGraphViewModel(data, i18n) : undefined), [data, i18n]);

  return (
    <Box flexDirection="column">
      <PanelView vm={vm} loading={loading} error={error} isActive={isActive} />
    </Box>
  );
}
