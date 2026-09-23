'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, RefreshCw, X, Terminal, RotateCcw } from 'lucide-react';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import {
  Button,
  Callout,
  Code,
  Disclosure,
  EmptyState,
  Grid,
  KeyValue,
  Metric,
  RadioGroup,
  Section,
  Segmented,
  Select,
  StatusPill,
  TextField,
  Textarea,
} from '@agent/shared-ui';
import {
  resolveChronosLocale,
  uxMessage,
  uxText,
  type SupportedLocale,
} from '../lib/ux-vocabulary';
import { useChronosLocale } from '../lib/hooks';
import {
  parseAgentHealthResponse,
  type ClientAgentHealthResponse,
  type ClientAgentRecord,
} from '../lib/agent-health-response';
import {
  parseAgentManifestsResponse,
  type ClientAgentManifest,
} from '../lib/agent-manifests-response';
import { parseAgentProvidersResponse } from '../lib/agent-providers-response';
import {
  parseManualCancelResponse,
  parseManualCommandStatusResponse,
  parseManualExecutionResponse,
  parseManualPeekResponse,
  parseManualQueuedResponse,
  type ClientManualDriveAction,
  type ClientManualExecutionStatus,
} from '../lib/agent-manual-response';
import { parseAgentLogsResponse } from '../lib/agent-logs-response';
import {
  parseAgentRefreshResponse,
  parseAgentRestartResponse,
  parseAgentShutdownResponse,
  parseAgentSpawnResponse,
} from '../lib/agent-control-response';
import { ChronosFieldScope, ChronosInline, ChronosMeta } from './chronos-ui';

type AgentRecord = ClientAgentRecord;
type HealthSnapshot = Pick<ClientAgentHealthResponse, 'total' | 'ready' | 'busy' | 'error'>;

type ChronosAccessRole = 'readonly' | 'localadmin';

type ManifestEntry = ClientAgentManifest;

interface ProviderOption {
  value: string;
  label: string;
  models: string[];
  installed: boolean;
  version: string | null;
  protocol: string;
}

type ManualDriveAction = ClientManualDriveAction;

interface ManualDriveCommand {
  commandId: string;
  state: 'queued' | 'running' | 'completed' | 'cancelled';
  status?: ClientManualExecutionStatus;
  approval?: { status: 'approved' | 'pending' | 'denied'; request_id?: string; message?: string };
  resumesCommandId?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  claude: 'Claude',
  copilot: 'GitHub Copilot',
  codex: 'Codex',
};

/** Runtime status → canonical `ui:status-pill` status. */
const AGENT_STATUS: Record<string, KbStatus> = {
  ready: 'ready',
  busy: 'busy',
  booting: 'connecting',
  error: 'error',
  registered: 'pending',
  shutdown: 'stopped',
};

function describeProviderResolution(agent: AgentRecord, locale: SupportedLocale): string | null {
  const resolution = agent.providerResolution;
  if (!resolution?.preferredProvider) return null;
  const preferred = `${resolution.preferredProvider}${resolution.preferredModelId ? `/${resolution.preferredModelId}` : ''}`;
  const resolved = `${agent.provider}${agent.modelId ? `/${agent.modelId}` : ''}`;
  return uxMessage(
    'chronos_agentpanel_provider_resolution',
    { preferred, resolved, strategy: resolution.strategy || 'preferred' },
    'Preferred {preferred} → resolved {resolved} ({strategy})',
    locale
  );
}

export function AgentPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const locale = useChronosLocale();
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [health, setHealth] = useState<HealthSnapshot>({ total: 0, ready: 0, busy: 0, error: 0 });
  const [accessRole, setAccessRole] = useState<ChronosAccessRole>('readonly');
  const [manifests, setManifests] = useState<ManifestEntry[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [showSpawn, setShowSpawn] = useState(false);
  const [spawnMode, setSpawnMode] = useState<'manifest' | 'custom'>('manifest');
  const [spawning, setSpawning] = useState(false);
  const [selectedManifest, setSelectedManifest] = useState('');
  const [spawnProvider, setSpawnProvider] = useState('');
  const [spawnModel, setSpawnModel] = useState('');
  const [spawnProviderStrategy, setSpawnProviderStrategy] = useState<
    'strict' | 'preferred' | 'adaptive'
  >('adaptive');
  const [spawnFallbackProviders, setSpawnFallbackProviders] = useState('');
  const [spawnPrompt, setSpawnPrompt] = useState('');
  const [viewingLogs, setViewingLogs] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ ts: number; type: string; content: string }[]>([]);
  const [mutatingAgent, setMutatingAgent] = useState<string | null>(null);
  const [manualActions, setManualActions] = useState<Record<string, ManualDriveAction | null>>({});
  const [manualCommands, setManualCommands] = useState<
    Record<string, ManualDriveCommand | undefined>
  >({});
  const [manualBusy, setManualBusy] = useState<Record<string, boolean>>({});
  const [manualErrors, setManualErrors] = useState<Record<string, string | undefined>>({});

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents');
      if (res.ok) {
        const data = parseAgentHealthResponse(await res.json());
        if (!data) return;
        setAgents(data.agents);
        setHealth(data);
        setAccessRole(data.accessRole);
      }
    } catch (_) {
      /* best-effort: failure here must not break the primary flow */
    }
  }, []);

  const fetchManifests = useCallback(async () => {
    try {
      const res = await fetch('/api/agents?manifests=true');
      if (res.ok) {
        const data = parseAgentManifestsResponse(await res.json());
        if (!data) return;
        setManifests(data.manifests);
        setAccessRole(data.accessRole);
      }
    } catch (_) {
      /* best-effort: failure here must not break the primary flow */
    }
  }, []);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch('/api/agents?providers=true');
      if (res.ok) {
        const data = parseAgentProvidersResponse(await res.json());
        if (!data) return;
        const opts: ProviderOption[] = data.providers.map((p) => ({
          value: p.provider,
          label: PROVIDER_LABELS[p.provider] || p.provider,
          models: p.models,
          installed: p.installed,
          version: p.installed && p.version && !p.version.includes('Error') ? p.version : null,
          protocol: p.protocol,
        }));
        setProviders(opts);
        setAccessRole(data.accessRole);
        // Auto-select first available provider if none selected
        setSpawnProvider((prev) => {
          if (prev) return prev;
          const first = opts.find((p) => p.installed);
          if (first) {
            if (first.models.length > 0) setSpawnModel(first.models[0]);
            return first.value;
          }
          return prev;
        });
      }
    } catch (_) {
      /* best-effort: failure here must not break the primary flow */
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    fetchAgents();
    fetchManifests();
    fetchProviders();
    const timer = setInterval(fetchAgents, 5000);
    return () => clearInterval(timer);
  }, [isOpen, fetchAgents, fetchManifests, fetchProviders]);

  const handleSpawn = async () => {
    setSpawning(true);
    try {
      let body: any;
      if (spawnMode === 'manifest' && selectedManifest) {
        // Spawn from manifest — just pass agentId, backend loads config from .agent.md
        const m = manifests.find((m) => m.agentId === selectedManifest);
        body = { agentId: selectedManifest, provider: m?.provider || 'gemini' };
      } else {
        body = {
          provider: spawnProvider,
          modelId: spawnModel,
          systemPrompt: spawnPrompt || undefined,
          runtimeMetadata: {
            provider_strategy: spawnProviderStrategy,
            fallback_providers: spawnFallbackProviders
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean),
          },
        };
      }

      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const parsed = parseAgentSpawnResponse(await res.json());
        if (!parsed) throw new Error('Agent spawn returned an invalid response.');
        setShowSpawn(false);
        setSpawnPrompt('');
        setSpawnProviderStrategy('adaptive');
        setSpawnFallbackProviders('');
        await fetchAgents();
      } else {
        alert(uxText('chronos_agentpanel_spawn_failed', locale));
      }
    } catch (_) {
      /* best-effort: failure here must not break the primary flow */
    }
    setSpawning(false);
  };

  const fetchLogs = async (agentId: string) => {
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logs', agentId, limit: 100 }),
      });
      if (res.ok) {
        const data = parseAgentLogsResponse(await res.json());
        if (!data || data.agentId !== agentId) return;
        setLogs(data.logs);
      }
    } catch (_) {
      /* best-effort: failure here must not break the primary flow */
    }
  };

  const handleViewLogs = (agentId: string) => {
    setViewingLogs(agentId);
    fetchLogs(agentId);
  };

  const handleShutdown = async (agentId: string) => {
    try {
      setMutatingAgent(agentId);
      const response = await fetch('/api/agents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
      if (!response.ok) throw new Error('Agent shutdown failed');
      const parsed = parseAgentShutdownResponse(await response.json());
      if (!parsed || parsed.agentId !== agentId)
        throw new Error('Agent shutdown returned an invalid response.');
      await fetchAgents();
    } catch (_) {
      /* best-effort cleanup */
    }
    setMutatingAgent(null);
  };

  const handleAgentAction = async (agentId: string, action: 'refresh' | 'restart') => {
    try {
      setMutatingAgent(agentId);
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, agentId }),
      });
      if (!response.ok) throw new Error(`Agent ${action} failed`);
      const payload = await response.json();
      const parsed =
        action === 'refresh'
          ? parseAgentRefreshResponse(payload)
          : parseAgentRestartResponse(payload);
      if (!parsed || parsed.agentId !== agentId)
        throw new Error(`Agent ${action} returned an invalid response.`);
      await fetchAgents();
      if (viewingLogs === agentId) {
        await fetchLogs(agentId);
      }
    } catch (_) {
      /* best-effort: failure here must not break the primary flow */
    }
    setMutatingAgent(null);
  };

  const inspectManualAction = async (agentId: string) => {
    setManualBusy((current) => ({ ...current, [agentId]: true }));
    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'manual_peek', agentId }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setManualActions((current) => ({ ...current, [agentId]: null }));
        setManualErrors((current) => ({
          ...current,
          [agentId]:
            response.status === 409
              ? uxText('chronos_agentpanel_manual_unavailable', locale)
              : uxText('chronos_agentpanel_manual_inspect_failed', locale),
        }));
        return;
      }
      const parsed = parseManualPeekResponse(payload);
      if (!parsed || parsed.agentId !== agentId) {
        throw new Error('Manual action inspection returned an invalid response.');
      }
      setManualActions((current) => ({ ...current, [agentId]: parsed.action }));
      setManualErrors((current) => ({ ...current, [agentId]: undefined }));
    } catch (error) {
      setManualErrors((current) => ({
        ...current,
        [agentId]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setManualBusy((current) => ({ ...current, [agentId]: false }));
    }
  };

  const pollManualCommand = async (agentId: string, commandId: string) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'manual_status', agentId, commandId }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error('Manual command status failed');
        const parsed = parseManualCommandStatusResponse(payload);
        if (!parsed || parsed.agentId !== agentId || parsed.commandId !== commandId) {
          throw new Error('Manual command status returned an invalid response.');
        }
        const command: ManualDriveCommand = {
          commandId,
          state: parsed.state,
          ...(parsed.actionStatus ? { status: parsed.actionStatus } : {}),
          ...(parsed.approval ? { approval: parsed.approval } : {}),
          ...(parsed.resumesCommandId ? { resumesCommandId: parsed.resumesCommandId } : {}),
        };
        setManualCommands((current) => ({ ...current, [agentId]: command }));
        if (command.state === 'completed' || command.state === 'cancelled') {
          await inspectManualAction(agentId);
          return;
        }
      } catch (error) {
        setManualErrors((current) => ({
          ...current,
          [agentId]: error instanceof Error ? error.message : String(error),
        }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  const executeManualAction = async (agentId: string) => {
    const action = manualActions[agentId];
    if (!action) return;
    setManualBusy((current) => ({ ...current, [agentId]: true }));
    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'manual_execute', agentId, actionId: action.action_id }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error('Manual action execution failed');
      if (response.status === 202) {
        const parsed = parseManualQueuedResponse(payload);
        if (!parsed || parsed.agentId !== agentId) {
          throw new Error('Manual action queue returned an invalid response.');
        }
        setManualCommands((current) => ({
          ...current,
          [agentId]: {
            commandId: parsed.commandId,
            state: 'queued',
            ...(parsed.resumesCommandId ? { resumesCommandId: parsed.resumesCommandId } : {}),
          },
        }));
        void pollManualCommand(agentId, parsed.commandId);
      } else {
        const parsed = parseManualExecutionResponse(payload);
        if (!parsed || parsed.agentId !== agentId) {
          throw new Error('Manual action execution returned an invalid response.');
        }
        setManualActions((current) => ({ ...current, [agentId]: parsed.action || null }));
        setManualCommands((current) => ({
          ...current,
          [agentId]: parsed.status
            ? {
                commandId: 'local',
                state: 'completed',
                status: parsed.status,
                ...(parsed.approval ? { approval: parsed.approval } : {}),
              }
            : undefined,
        }));
      }
      setManualErrors((current) => ({ ...current, [agentId]: undefined }));
    } catch (error) {
      setManualErrors((current) => ({
        ...current,
        [agentId]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setManualBusy((current) => ({ ...current, [agentId]: false }));
    }
  };

  const cancelManualCommand = async (agentId: string) => {
    const command = manualCommands[agentId];
    if (!command || command.commandId === 'local') return;
    setManualBusy((current) => ({ ...current, [agentId]: true }));
    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'manual_cancel', agentId, commandId: command.commandId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error('Manual command cancellation failed');
      const parsed = parseManualCancelResponse(payload);
      if (!parsed || parsed.agentId !== agentId || parsed.commandId !== command.commandId) {
        throw new Error('Manual command cancellation returned an invalid response.');
      }
      if (parsed.status === 'cancelled') {
        setManualCommands((current) => ({
          ...current,
          [agentId]: { ...command, state: 'cancelled' },
        }));
      }
      setManualErrors((current) => ({ ...current, [agentId]: undefined }));
    } catch (error) {
      setManualErrors((current) => ({
        ...current,
        [agentId]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setManualBusy((current) => ({ ...current, [agentId]: false }));
    }
  };

  const resumeManualCommand = async (agentId: string) => {
    const command = manualCommands[agentId];
    if (!command || command.commandId === 'local' || command.status !== 'awaiting_approval') return;
    setManualBusy((current) => ({ ...current, [agentId]: true }));
    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'manual_resume', agentId, commandId: command.commandId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error('Manual command resume failed');
      if (response.status === 202) {
        const parsed = parseManualQueuedResponse(payload);
        if (
          !parsed ||
          parsed.agentId !== agentId ||
          parsed.resumesCommandId !== command.commandId
        ) {
          throw new Error('Manual command resume returned an invalid response.');
        }
        setManualCommands((current) => ({
          ...current,
          [agentId]: {
            commandId: parsed.commandId,
            state: 'queued',
            ...(parsed.resumesCommandId ? { resumesCommandId: parsed.resumesCommandId } : {}),
          },
        }));
        void pollManualCommand(agentId, parsed.commandId);
      } else {
        const parsed = parseManualExecutionResponse(payload);
        if (!parsed || parsed.agentId !== agentId) {
          throw new Error('Manual command resume returned an invalid response.');
        }
      }
      setManualErrors((current) => ({ ...current, [agentId]: undefined }));
    } catch (error) {
      setManualErrors((current) => ({
        ...current,
        [agentId]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setManualBusy((current) => ({ ...current, [agentId]: false }));
    }
  };

  if (!isOpen) return null;

  // Filter out already-running agents from manifest list
  const runningIds = new Set(agents.map((a) => a.agentId));
  const availableManifests = manifests.filter((m) => !runningIds.has(m.agentId));
  const installedProviders = providers.filter((p) => p.installed);
  const missingProviders = providers.filter((p) => !p.installed);

  const onSpawnField = (name: string, value: unknown) => {
    const next = typeof value === 'string' ? value : String(value ?? '');
    switch (name) {
      case 'spawnMode':
        if (next === 'manifest' || next === 'custom') setSpawnMode(next);
        break;
      case 'manifest':
        setSelectedManifest(next);
        break;
      case 'provider': {
        setSpawnProvider(next);
        const pc = providers.find((p) => p.value === next);
        if (pc && pc.models.length > 0) setSpawnModel(pc.models[0]);
        break;
      }
      case 'model':
        setSpawnModel(next);
        break;
      case 'systemPrompt':
        setSpawnPrompt(next);
        break;
      case 'strategy':
        if (next === 'strict' || next === 'preferred' || next === 'adaptive') {
          setSpawnProviderStrategy(next);
        }
        break;
      case 'fallbackProviders':
        setSpawnFallbackProviders(next);
        break;
      default:
        break;
    }
  };

  const openSpawn = () => {
    setShowSpawn(true);
    setSpawnMode('manifest');
    setSelectedManifest('');
  };

  return (
    <div className="chronos-agent-panel">
      <div className="chronos-agent-panel__scrim" aria-hidden="true" onClick={onClose} />
      <aside
        className="chronos-agent-panel__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chronos-agent-panel-title"
      >
        <header className="chronos-agent-panel__header">
          <h2 id="chronos-agent-panel-title" className="chronos-agent-panel__title">
            {uxText('chronos_agent_runtimes', locale)}
          </h2>
          <Button label={uxText('chronos_refresh', locale)} variant="ghost" onClick={fetchAgents}>
            <RefreshCw size={14} aria-hidden="true" />
          </Button>
          <Button label={uxText('chronos_close', locale)} variant="ghost" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </Button>
        </header>

        <div className="chronos-agent-panel__body">
          {agents.length > 0 ? (
            <Grid columns={3} gap="sm">
              <Metric label={uxText('chronos_ready', locale)} value={health.ready} tone="success" />
              <Metric
                label={uxText('chronos_agentpanel_busy', locale)}
                value={health.busy}
                tone="warning"
              />
              <Metric
                label={uxText('chronos_agentpanel_errors', locale)}
                value={health.error}
                tone={health.error > 0 ? 'danger' : 'neutral'}
              />
            </Grid>
          ) : null}

          {agents.length === 0 && !showSpawn ? (
            <div className="chronos-stack">
              <EmptyState
                title={uxText('chronos_agentpanel_empty_title', locale)}
                body={uxText('chronos_agentpanel_empty_body', locale)}
              />
              <Button
                label={uxText('chronos_agentpanel_spawn_first', locale)}
                variant="primary"
                onClick={() => setShowSpawn(true)}
              />
            </div>
          ) : null}

          {agents.length > 0 ? (
            <ul className="chronos-agent-panel__agents">
              {agents.map((agent) => {
                const metrics = agent.metrics || {
                  turnCount: 0,
                  errorCount: 0,
                  restartCount: 0,
                  refreshCount: 0,
                  totalPromptChars: 0,
                  totalResponseChars: 0,
                };
                const idleSeconds = Math.round(
                  ((agent.runtime?.idleForMs ?? agent.idleMs) || 0) / 1000
                );
                const trustLabel = typeof agent.trustScore === 'number' ? agent.trustScore : 'n/a';
                const resolution = describeProviderResolution(agent, locale);
                const manualAction = manualActions[agent.agentId];
                const manualCommand = manualCommands[agent.agentId];
                const manualError = manualErrors[agent.agentId];
                const busy = Boolean(manualBusy[agent.agentId]);
                const commandPending = Boolean(
                  manualCommand &&
                  manualCommand.state !== 'completed' &&
                  manualCommand.state !== 'cancelled'
                );
                const mutating = mutatingAgent === agent.agentId;
                const isAdmin = accessRole === 'localadmin';
                const details: Array<{ label: string; value: string | number; mono?: boolean }> = [
                  { label: uxText('chronos_agentpanel_trust', locale), value: trustLabel },
                  ...(agent.capabilities.length > 0
                    ? [
                        {
                          label: uxText('chronos_agentpanel_capabilities', locale),
                          value: agent.capabilities.join(', '),
                        },
                      ]
                    : []),
                  ...(resolution
                    ? [
                        {
                          label: uxText('chronos_agentpanel_provider_routing', locale),
                          value: resolution,
                          mono: true,
                        },
                      ]
                    : []),
                  { label: uxText('chronos_agentpanel_turns', locale), value: metrics.turnCount },
                  { label: uxText('chronos_agentpanel_errors', locale), value: metrics.errorCount },
                  {
                    label: uxText('chronos_agentpanel_refreshes', locale),
                    value: metrics.refreshCount,
                  },
                  {
                    label: uxText('chronos_agentpanel_restarts', locale),
                    value: metrics.restartCount,
                  },
                  { label: uxText('chronos_agentpanel_idle', locale), value: `${idleSeconds}s` },
                  ...(typeof agent.process?.rssKb === 'number'
                    ? [
                        {
                          label: uxText('chronos_agentpanel_memory', locale),
                          value: `${(agent.process.rssKb / 1024).toFixed(1)} MB`,
                        },
                      ]
                    : []),
                  ...(typeof metrics.usage?.totalTokens === 'number'
                    ? [
                        {
                          label: uxText('chronos_agentpanel_tokens', locale),
                          value: metrics.usage.totalTokens,
                        },
                      ]
                    : []),
                ];
                return (
                  <li key={agent.agentId} className="chronos-agent-panel__agent">
                    <div className="chronos-agent-panel__agent-head">
                      <div className="chronos-mission-cell">
                        <span className="chronos-mission-cell__title">{agent.agentId}</span>
                        <span className="chronos-mission-cell__id">
                          {agent.provider}/{agent.modelId}
                        </span>
                      </div>
                      <StatusPill status={AGENT_STATUS[agent.status] || 'n/a'} />
                    </div>
                    <Disclosure summary={uxText('chronos_agentpanel_details', locale)}>
                      <KeyValue items={details} />
                    </Disclosure>
                    {manualAction || manualCommand ? (
                      <ChronosMeta mono>
                        {[
                          manualAction
                            ? uxMessage(
                                'chronos_agentpanel_manual_state',
                                { title: manualAction.title, status: manualAction.status },
                                'Manual drive: {title} ({status})',
                                locale
                              )
                            : '',
                          manualCommand
                            ? uxMessage(
                                'chronos_agentpanel_command_state',
                                {
                                  state: `${manualCommand.state}${manualCommand.status ? `/${manualCommand.status}` : ''}`,
                                },
                                'Command {state}',
                                locale
                              )
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </ChronosMeta>
                    ) : null}
                    {manualError ? <Callout tone="danger" title={manualError} /> : null}
                    <ChronosInline>
                      <Button
                        label={uxText('chronos_agentpanel_soft_refresh', locale)}
                        variant="ghost"
                        onClick={() => handleAgentAction(agent.agentId, 'refresh')}
                        disabled={!isAdmin || mutating || !agent.supportsSoftRefresh}
                      >
                        <RefreshCw size={14} aria-hidden="true" />
                        {uxText('chronos_agentpanel_soft_refresh', locale)}
                      </Button>
                      <Button
                        label={uxText('chronos_restart_runtime', locale)}
                        variant="ghost"
                        onClick={() => handleAgentAction(agent.agentId, 'restart')}
                        disabled={!isAdmin || mutating}
                      >
                        <RotateCcw size={14} aria-hidden="true" />
                        {uxText('chronos_restart_runtime', locale)}
                      </Button>
                      <Button
                        label={uxText('chronos_agentpanel_view_logs', locale)}
                        variant="ghost"
                        onClick={() => handleViewLogs(agent.agentId)}
                      >
                        <Terminal size={14} aria-hidden="true" />
                        {uxText('chronos_agentpanel_view_logs', locale)}
                      </Button>
                      <Button
                        label={uxText('chronos_agentpanel_shutdown', locale)}
                        variant="danger"
                        onClick={() => handleShutdown(agent.agentId)}
                        disabled={!isAdmin || mutating}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        {uxText('chronos_agentpanel_shutdown', locale)}
                      </Button>
                    </ChronosInline>
                    {isAdmin ? (
                      <ChronosInline>
                        <ChronosMeta>{uxText('chronos_agentpanel_manual', locale)}</ChronosMeta>
                        <Button
                          label={
                            busy
                              ? uxText('chronos_agentpanel_manual_checking', locale)
                              : uxText('chronos_agentpanel_manual_next', locale)
                          }
                          variant="secondary"
                          onClick={() => void inspectManualAction(agent.agentId)}
                          disabled={busy}
                        />
                        {manualAction ? (
                          <Button
                            label={uxText('chronos_agentpanel_manual_step', locale)}
                            variant="primary"
                            onClick={() => void executeManualAction(agent.agentId)}
                            disabled={busy || manualAction.status !== 'ready' || commandPending}
                          />
                        ) : null}
                        {manualCommand?.state === 'completed' &&
                        manualCommand.status === 'awaiting_approval' ? (
                          <Button
                            label={uxText('chronos_agentpanel_manual_resume', locale)}
                            variant="secondary"
                            onClick={() => void resumeManualCommand(agent.agentId)}
                            disabled={busy}
                          />
                        ) : null}
                        {manualCommand && manualCommand.commandId !== 'local' && commandPending ? (
                          <Button
                            label={uxText('chronos_agentpanel_manual_cancel', locale)}
                            variant="danger"
                            onClick={() => void cancelManualCommand(agent.agentId)}
                            disabled={busy}
                          />
                        ) : null}
                      </ChronosInline>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {viewingLogs ? (
            <Section
              title={uxMessage(
                'chronos_agentpanel_logs_title',
                { agentId: viewingLogs },
                'Logs: {agentId}',
                locale
              )}
              headingLevel={3}
            >
              <ChronosInline>
                <Button
                  label={uxText('chronos_refresh', locale)}
                  variant="secondary"
                  onClick={() => fetchLogs(viewingLogs)}
                />
                <Button
                  label={uxText('chronos_close', locale)}
                  variant="ghost"
                  onClick={() => setViewingLogs(null)}
                />
              </ChronosInline>
              {logs.length === 0 ? (
                <p className="kb-text kb-text--muted">{uxText('chronos_no_logs_yet', locale)}</p>
              ) : (
                <Code
                  code={logs
                    .map((entry) => {
                      const time = new Date(entry.ts).toLocaleTimeString(resolveChronosLocale());
                      const content =
                        entry.content.length > 200
                          ? `${entry.content.slice(0, 200)}...`
                          : entry.content;
                      return `[${time}] ${entry.type} ${content}`;
                    })
                    .join('\n')}
                />
              )}
            </Section>
          ) : null}

          {showSpawn ? (
            <Section title={uxText('chronos_agentpanel_spawn_title', locale)} headingLevel={3}>
              <ChronosFieldScope onChange={onSpawnField}>
                <div className="chronos-stack">
                  <Segmented
                    name="spawnMode"
                    label={uxText('chronos_agentpanel_spawn_mode', locale)}
                    value={spawnMode}
                    options={[
                      { value: 'manifest', label: uxText('chronos_from_manifest', locale) },
                      { value: 'custom', label: uxText('chronos_custom', locale) },
                    ]}
                  />
                  {spawnMode === 'manifest' ? (
                    availableManifests.length === 0 ? (
                      <p className="kb-text kb-text--muted">
                        {uxText('chronos_all_agents_running', locale)}
                      </p>
                    ) : (
                      <RadioGroup
                        name="manifest"
                        label={uxText('chronos_select_agent_definition', locale)}
                        value={selectedManifest}
                        options={availableManifests.map((m) => ({
                          value: m.agentId,
                          label: m.agentId,
                          description: [
                            `${m.provider}/${m.modelId}`,
                            m.capabilities.length > 0 ? m.capabilities.join(', ') : '',
                            m.requiresEnv.length > 0
                              ? uxMessage(
                                  'chronos_agentpanel_needs_env',
                                  { env: m.requiresEnv.join(', ') },
                                  'Needs {env}',
                                  locale
                                )
                              : '',
                            uxMessage(
                              'chronos_agentpanel_strategy_value',
                              { strategy: m.providerStrategy || 'adaptive' },
                              'Strategy: {strategy}',
                              locale
                            ),
                            (m.fallbackProviders || []).length
                              ? uxMessage(
                                  'chronos_agentpanel_fallback_value',
                                  { providers: (m.fallbackProviders || []).join(', ') },
                                  'Fallback: {providers}',
                                  locale
                                )
                              : '',
                          ]
                            .filter(Boolean)
                            .join(' · '),
                        }))}
                      />
                    )
                  ) : (
                    <>
                      {installedProviders.length === 0 ? (
                        <p className="kb-text kb-text--muted">
                          {uxText('chronos_agentpanel_scanning_providers', locale)}
                        </p>
                      ) : (
                        <Grid columns={2} gap="sm">
                          <Select
                            name="provider"
                            label={uxText('chronos_agentpanel_provider', locale)}
                            value={spawnProvider}
                            options={installedProviders.map((p) => ({
                              value: p.value,
                              label: `${p.label}${p.version ? ` (${p.version})` : ''} [${p.protocol}]`,
                            }))}
                          />
                          <Select
                            name="model"
                            label={uxText('chronos_agentpanel_model', locale)}
                            value={spawnModel}
                            options={(
                              providers.find((p) => p.value === spawnProvider)?.models || []
                            ).map((m) => ({ value: m, label: m }))}
                          />
                        </Grid>
                      )}
                      {missingProviders.length > 0 ? (
                        <ChronosMeta>
                          {uxMessage(
                            'chronos_agentpanel_not_installed',
                            { providers: missingProviders.map((p) => p.label).join(', ') },
                            'Not installed: {providers}',
                            locale
                          )}
                        </ChronosMeta>
                      ) : null}
                      <Textarea
                        name="systemPrompt"
                        label={uxText('chronos_agentpanel_system_prompt', locale)}
                        value={spawnPrompt}
                        rows={2}
                      />
                      <Grid columns={2} gap="sm">
                        <Select
                          name="strategy"
                          label={uxText('chronos_agentpanel_strategy', locale)}
                          value={spawnProviderStrategy}
                          options={[
                            {
                              value: 'adaptive',
                              label: uxText('chronos_agentpanel_strategy_adaptive', locale),
                            },
                            {
                              value: 'preferred',
                              label: uxText('chronos_agentpanel_strategy_preferred', locale),
                            },
                            {
                              value: 'strict',
                              label: uxText('chronos_agentpanel_strategy_strict', locale),
                            },
                          ]}
                        />
                        <TextField
                          name="fallbackProviders"
                          label={uxText('chronos_agentpanel_fallback', locale)}
                          help={uxText('chronos_agentpanel_fallback_help', locale)}
                          value={spawnFallbackProviders}
                          placeholder="claude,codex"
                        />
                      </Grid>
                    </>
                  )}
                  <ChronosInline>
                    <Button
                      label={uxText('chronos_agentpanel_cancel', locale)}
                      variant="ghost"
                      onClick={() => setShowSpawn(false)}
                    />
                    <Button
                      label={
                        spawning
                          ? uxText('chronos_agentpanel_spawning', locale)
                          : uxText('chronos_agentpanel_spawn', locale)
                      }
                      variant="primary"
                      onClick={handleSpawn}
                      disabled={spawning || (spawnMode === 'manifest' && !selectedManifest)}
                    />
                  </ChronosInline>
                </div>
              </ChronosFieldScope>
            </Section>
          ) : null}
        </div>

        <footer className="chronos-agent-panel__footer">
          <ChronosMeta mono>
            {uxMessage(
              'chronos_agentpanel_summary',
              {
                total: health.total,
                manifests: manifests.length,
                role:
                  accessRole === 'localadmin'
                    ? uxText('chronos_agentpanel_role_localadmin', locale)
                    : uxText('chronos_agentpanel_role_readonly', locale),
              },
              '{total} registered · {manifests} manifests · {role}',
              locale
            )}
          </ChronosMeta>
          {!showSpawn && accessRole === 'localadmin' ? (
            <Button
              label={uxText('chronos_agentpanel_spawn', locale)}
              variant="primary"
              onClick={openSpawn}
            >
              <Plus size={14} aria-hidden="true" />
              {uxText('chronos_agentpanel_spawn', locale)}
            </Button>
          ) : null}
        </footer>
      </aside>
    </div>
  );
}
