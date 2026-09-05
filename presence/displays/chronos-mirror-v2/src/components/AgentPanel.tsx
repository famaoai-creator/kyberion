'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, RefreshCw, Cpu, X, FileText, Terminal, RotateCcw } from 'lucide-react';
import { resolveChronosLocale, uxText, uxTextOr } from '../lib/ux-vocabulary';
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
import { KyberionDonut } from './KyberionCharts';

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

const STATUS_COLORS: Record<string, string> = {
  ready: 'kb-status-positive-surface',
  busy: 'kb-status-warning-surface animate-pulse',
  booting: 'kb-surface-accent animate-pulse',
  error: 'kb-status-negative-surface',
  registered: 'kb-surface-sunken',
  shutdown: 'kb-surface-well',
};

function describeProviderResolution(agent: AgentRecord): string | null {
  const resolution = agent.providerResolution;
  if (!resolution?.preferredProvider) return null;
  const preferred = `${resolution.preferredProvider}${resolution.preferredModelId ? `/${resolution.preferredModelId}` : ''}`;
  const resolved = `${agent.provider}${agent.modelId ? `/${agent.modelId}` : ''}`;
  return `preferred ${preferred} -> resolved ${resolved} [${resolution.strategy || 'preferred'}]`;
}

export function AgentPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const locale = resolveChronosLocale();
  const at = (key: string, fallbackEn: string) => uxTextOr(key, fallbackEn, locale);
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
        alert('Spawn failed');
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
              ? 'Manual drive is not available for this runtime.'
              : 'Manual action inspection failed.',
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

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 kb-surface-well backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[600px] max-h-[80vh] kyberion-glass rounded-2xl border kb-status-warning-border flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b kb-border-subtle">
          <div className="flex items-center gap-3">
            <Cpu className="kb-status-warning w-5 h-5" />
            <span className="text-sm font-bold uppercase tracking-widest">
              {at('chronos_agent_registry', 'Agent Registry')}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex gap-2 text-[9px] font-mono">
              <span className="px-2 py-0.5 rounded kb-status-positive-surface kb-status-positive">
                {health.ready} ready
              </span>
              <span className="px-2 py-0.5 rounded kb-status-warning-surface kb-status-warning">
                {health.busy} busy
              </span>
              {health.error > 0 && (
                <span className="px-2 py-0.5 rounded kb-status-negative-surface kb-status-negative">
                  {health.error} error
                </span>
              )}
            </div>
            <button onClick={fetchAgents} className="opacity-40 hover:opacity-80 transition">
              <RefreshCw size={14} />
            </button>
            <button onClick={onClose} className="opacity-40 hover:opacity-80 transition">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Health distribution chart */}
        {agents.length > 0 && (
          <div className="px-6 pt-4">
            <KyberionDonut
              title={at('chronos_agent_health', 'Agent Health')}
              centerLabel={at('chronos_agents', 'Agents')}
              data={[
                { label: at('chronos_ready', 'Ready'), value: health.ready, color: '#34D399' },
                { label: at('chronos_busy', 'Busy'), value: health.busy, color: '#FBBF24' },
                { label: at('chronos_error', 'Error'), value: health.error, color: '#FB7185' },
              ]}
            />
          </div>
        )}

        {/* Agent List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {agents.length === 0 && !showSpawn && (
            <div className="flex flex-col items-center gap-3 py-10 px-6 text-center">
              <div className="text-[11px] uppercase tracking-[0.25em] kb-text-muted">
                {at('chronos_no_agents_running', 'No agents running yet')}
              </div>
              <div className="max-w-[260px] text-[11px] leading-relaxed kb-text-muted">
                {at(
                  'chronos_no_agents_hint',
                  'Spawn the first agent to begin Mission control. You can pick a pre-configured manifest or define a custom provider/model.'
                )}
              </div>
              <button
                onClick={() => setShowSpawn(true)}
                className="mt-2 inline-flex items-center gap-2 rounded-lg border kb-border-accent kb-surface-accent px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest kb-text-accent transition hover:kb-surface-accent"
              >
                <Plus size={12} />
                <span>{at('chronos_spawn_first_agent', 'Spawn First Agent')}</span>
              </button>
            </div>
          )}
          {agents.map((agent) => (
            <div
              key={agent.agentId}
              className="flex items-center gap-3 p-3 kb-surface-well rounded-xl border kb-border-subtle"
            >
              {(() => {
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
                return (
                  <>
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${STATUS_COLORS[agent.status] || 'kb-surface-sunken'}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-bold font-mono truncate">
                        {agent.agentId}
                      </div>
                      <div className="text-[9px] opacity-40 flex gap-3 mt-0.5">
                        <span>
                          {agent.provider}/{agent.modelId}
                        </span>
                        <span>Trust: {trustLabel}</span>
                        {agent.capabilities.length > 0 && (
                          <span>[{agent.capabilities.join(', ')}]</span>
                        )}
                      </div>
                      {describeProviderResolution(agent) ? (
                        <div className="text-[8px] opacity-35 mt-1 font-mono">
                          {describeProviderResolution(agent)}
                        </div>
                      ) : null}
                      <div className="text-[8px] opacity-35 flex flex-wrap gap-3 mt-1 font-mono">
                        <span>turns {metrics.turnCount}</span>
                        <span>errors {metrics.errorCount}</span>
                        <span>refresh {metrics.refreshCount}</span>
                        <span>restart {metrics.restartCount}</span>
                        <span>idle {idleSeconds}s</span>
                        {typeof agent.process?.rssKb === 'number' && (
                          <span>rss {(agent.process.rssKb / 1024).toFixed(1)}MB</span>
                        )}
                        {typeof metrics.usage?.totalTokens === 'number' && (
                          <span>tokens {metrics.usage.totalTokens}</span>
                        )}
                      </div>
                    </div>
                    <div className="text-[8px] uppercase tracking-widest opacity-40">
                      {agent.status}
                    </div>
                    {accessRole === 'localadmin' && (
                      <div className="flex items-center gap-1.5 text-[8px]">
                        <button
                          type="button"
                          onClick={() => void inspectManualAction(agent.agentId)}
                          disabled={manualBusy[agent.agentId]}
                          className="rounded border kb-border-subtle px-1.5 py-1 kb-text-secondary hover:kb-surface-accent disabled:opacity-30"
                          title="Inspect the next safe manual-drive action"
                        >
                          {manualBusy[agent.agentId] ? '…' : 'Next'}
                        </button>
                        {manualActions[agent.agentId] ? (
                          <button
                            type="button"
                            onClick={() => void executeManualAction(agent.agentId)}
                            disabled={
                              manualBusy[agent.agentId] ||
                              manualActions[agent.agentId]?.status !== 'ready' ||
                              Boolean(
                                manualCommands[agent.agentId] &&
                                manualCommands[agent.agentId]?.state !== 'completed' &&
                                manualCommands[agent.agentId]?.state !== 'cancelled'
                              )
                            }
                            className="rounded border kb-status-warning-border kb-status-warning-surface px-1.5 py-1 kb-status-warning disabled:opacity-30"
                            title={manualActions[agent.agentId]?.title}
                          >
                            Step
                          </button>
                        ) : null}
                        {manualCommands[agent.agentId]?.state === 'completed' &&
                        manualCommands[agent.agentId]?.status === 'awaiting_approval' ? (
                          <button
                            type="button"
                            onClick={() => void resumeManualCommand(agent.agentId)}
                            disabled={manualBusy[agent.agentId]}
                            className="rounded border kb-status-warning-border kb-status-warning-surface px-1.5 py-1 kb-status-warning disabled:opacity-30"
                            title="Re-run the approval gate for this manual command"
                          >
                            Resume
                          </button>
                        ) : null}
                        {manualCommands[agent.agentId] &&
                        manualCommands[agent.agentId]?.commandId !== 'local' &&
                        manualCommands[agent.agentId]?.state !== 'completed' &&
                        manualCommands[agent.agentId]?.state !== 'cancelled' ? (
                          <button
                            type="button"
                            onClick={() => void cancelManualCommand(agent.agentId)}
                            disabled={manualBusy[agent.agentId]}
                            className="rounded border kb-status-negative-border kb-status-negative-surface px-1.5 py-1 kb-status-negative disabled:opacity-30"
                            title="Cancel pending durable manual command"
                          >
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    )}
                    {manualActions[agent.agentId] ||
                    manualCommands[agent.agentId] ||
                    manualErrors[agent.agentId] ? (
                      <div className="basis-full ml-5 text-[8px] font-mono opacity-60">
                        {manualActions[agent.agentId]
                          ? `manual: ${manualActions[agent.agentId]?.title} (${manualActions[agent.agentId]?.status})`
                          : null}
                        {manualCommands[agent.agentId]
                          ? ` · command ${manualCommands[agent.agentId]?.state}${manualCommands[agent.agentId]?.status ? `/${manualCommands[agent.agentId]?.status}` : ''}`
                          : null}
                        {manualErrors[agent.agentId] ? (
                          <span className="kb-status-negative">
                            {' '}
                            · {manualErrors[agent.agentId]}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    <button
                      onClick={() => handleAgentAction(agent.agentId, 'refresh')}
                      disabled={
                        accessRole !== 'localadmin' ||
                        mutatingAgent === agent.agentId ||
                        !agent.supportsSoftRefresh
                      }
                      className="p-1.5 rounded-lg hover:kb-status-positive-surface kb-status-positive hover:kb-status-positive transition disabled:opacity-20"
                      title={
                        agent.supportsSoftRefresh
                          ? 'Soft refresh context'
                          : 'Soft refresh unsupported'
                      }
                    >
                      <RefreshCw size={12} />
                    </button>
                    <button
                      onClick={() => handleAgentAction(agent.agentId, 'restart')}
                      disabled={accessRole !== 'localadmin' || mutatingAgent === agent.agentId}
                      className="p-1.5 rounded-lg hover:kb-status-warning-surface kb-status-warning hover:kb-status-warning transition disabled:opacity-20"
                      title="Restart agent runtime"
                    >
                      <RotateCcw size={12} />
                    </button>
                    <button
                      onClick={() => handleViewLogs(agent.agentId)}
                      className="p-1.5 rounded-lg hover:kb-surface-accent kb-text-accent hover:kb-text-accent transition"
                      title="View terminal logs"
                    >
                      <Terminal size={12} />
                    </button>
                    <button
                      onClick={() => handleShutdown(agent.agentId)}
                      disabled={accessRole !== 'localadmin' || mutatingAgent === agent.agentId}
                      className="p-1.5 rounded-lg hover:kb-status-negative-surface kb-status-negative hover:kb-status-negative transition disabled:opacity-20"
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                );
              })()}
            </div>
          ))}

          {/* Log Viewer */}
          {viewingLogs && (
            <div className="p-4 kb-surface-well rounded-xl border kb-border-accent space-y-2">
              <div className="flex justify-between items-center">
                <div className="text-[10px] font-bold uppercase tracking-widest opacity-60 flex items-center gap-2">
                  <Terminal size={12} /> {viewingLogs}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => fetchLogs(viewingLogs)}
                    className="text-[9px] kb-text-accent hover:kb-text-accent"
                  >
                    {at('chronos_refresh', 'Refresh')}
                  </button>
                  <button
                    onClick={() => setViewingLogs(null)}
                    className="text-[9px] opacity-40 hover:opacity-80"
                  >
                    {at('chronos_close', 'Close')}
                  </button>
                </div>
              </div>
              <div className="max-h-[250px] overflow-y-auto font-mono text-[9px] space-y-0.5 kb-surface-well rounded-lg p-3">
                {logs.length === 0 ? (
                  <div className="text-center opacity-30 italic py-4">
                    {at('chronos_no_logs_yet', 'No logs yet. Send a message to this agent first.')}
                  </div>
                ) : (
                  logs.map((entry, i) => {
                    const typeColors: Record<string, string> = {
                      agent: 'kb-status-positive',
                      prompt: 'kb-text-accent',
                      out: 'kb-text-accent',
                      in: 'kb-text-secondary',
                      stderr: 'kb-status-negative',
                      text: 'kb-status-warning',
                    };
                    const time = new Date(entry.ts).toLocaleTimeString(resolveChronosLocale());
                    return (
                      <div
                        key={i}
                        className={`${typeColors[entry.type] || 'opacity-40'} break-all`}
                      >
                        <span className="opacity-40">[{time}]</span>{' '}
                        <span className="opacity-50 uppercase">{entry.type}</span>{' '}
                        {entry.content.slice(0, 200)}
                        {entry.content.length > 200 ? '...' : ''}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Spawn Form */}
          {showSpawn && (
            <div className="p-4 kb-surface-well rounded-xl border kb-status-warning-border space-y-3">
              {/* Mode Toggle */}
              <div className="flex gap-2 mb-2">
                <button
                  onClick={() => setSpawnMode('manifest')}
                  className={`flex-1 py-1.5 rounded-lg text-[9px] uppercase tracking-widest transition border ${
                    spawnMode === 'manifest'
                      ? 'kb-status-warning-surface kb-status-warning-border'
                      : 'kb-border-subtle opacity-40'
                  }`}
                >
                  <FileText size={10} className="inline mr-1" />{' '}
                  {at('chronos_from_manifest', 'From Manifest')}
                </button>
                <button
                  onClick={() => setSpawnMode('custom')}
                  className={`flex-1 py-1.5 rounded-lg text-[9px] uppercase tracking-widest transition border ${
                    spawnMode === 'custom'
                      ? 'kb-status-warning-surface kb-status-warning-border'
                      : 'kb-border-subtle opacity-40'
                  }`}
                >
                  <Plus size={10} className="inline mr-1" /> {at('chronos_custom', 'Custom')}
                </button>
              </div>

              {spawnMode === 'manifest' ? (
                <>
                  <div className="text-[10px] font-bold uppercase tracking-widest opacity-60">
                    {at('chronos_select_agent_definition', 'Select Agent Definition')}
                  </div>
                  {availableManifests.length === 0 ? (
                    <div className="text-[10px] opacity-30 italic">
                      {at('chronos_all_agents_running', 'All defined agents are already running.')}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {availableManifests.map((m) => (
                        <button
                          key={m.agentId}
                          onClick={() => setSelectedManifest(m.agentId)}
                          className={`w-full text-left p-3 rounded-lg border transition ${
                            selectedManifest === m.agentId
                              ? 'kb-status-warning-border kb-status-warning-surface'
                              : 'kb-border-subtle hover:kb-border-subtle'
                          }`}
                        >
                          <div className="text-[10px] font-bold font-mono">{m.agentId}</div>
                          <div className="text-[9px] opacity-40 flex gap-3 mt-0.5">
                            <span>
                              {m.provider}/{m.modelId}
                            </span>
                            {m.capabilities.length > 0 && (
                              <span>[{m.capabilities.join(', ')}]</span>
                            )}
                            {m.requiresEnv.length > 0 && (
                              <span className="kb-status-warning">
                                needs: {m.requiresEnv.join(', ')}
                              </span>
                            )}
                          </div>
                          <div className="text-[8px] opacity-35 mt-1 font-mono">
                            strategy {m.providerStrategy || 'adaptive'}
                            {(m.fallbackProviders || []).length
                              ? ` · fallback ${(m.fallbackProviders || []).join(', ')}`
                              : ''}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="text-[10px] font-bold uppercase tracking-widest opacity-60">
                    Custom Agent
                  </div>
                  {providers.filter((p) => p.installed).length === 0 ? (
                    <div className="text-[10px] opacity-30 italic">Scanning providers...</div>
                  ) : (
                    <div className="flex gap-2">
                      <select
                        value={spawnProvider}
                        onChange={(e) => {
                          setSpawnProvider(e.target.value);
                          const pc = providers.find((p) => p.value === e.target.value);
                          if (pc && pc.models.length > 0) setSpawnModel(pc.models[0]);
                        }}
                        className="flex-1 kb-surface-raised/5 border kb-border-subtle rounded-lg px-3 py-1.5 text-[10px] outline-none"
                      >
                        {providers
                          .filter((p) => p.installed)
                          .map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label} {p.version ? `(${p.version})` : ''} [{p.protocol}]
                            </option>
                          ))}
                      </select>
                      <select
                        value={spawnModel}
                        onChange={(e) => setSpawnModel(e.target.value)}
                        className="flex-1 kb-surface-raised/5 border kb-border-subtle rounded-lg px-3 py-1.5 text-[10px] outline-none"
                      >
                        {(providers.find((p) => p.value === spawnProvider)?.models || []).map(
                          (m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                  )}
                  {/* Show unavailable providers */}
                  {providers.filter((p) => !p.installed).length > 0 && (
                    <div className="text-[9px] opacity-30 mt-1">
                      Not installed:{' '}
                      {providers
                        .filter((p) => !p.installed)
                        .map((p) => p.label)
                        .join(', ')}
                    </div>
                  )}
                  <textarea
                    value={spawnPrompt}
                    onChange={(e) => setSpawnPrompt(e.target.value)}
                    placeholder="System prompt (optional)..."
                    rows={2}
                    className="w-full kb-surface-raised/5 border kb-border-subtle rounded-lg px-3 py-2 text-[10px] outline-none resize-none"
                  />
                  <div className="grid gap-2 md:grid-cols-2">
                    <select
                      value={spawnProviderStrategy}
                      onChange={(e) =>
                        setSpawnProviderStrategy(
                          e.target.value as 'strict' | 'preferred' | 'adaptive'
                        )
                      }
                      className="kb-surface-raised/5 border kb-border-subtle rounded-lg px-3 py-1.5 text-[10px] outline-none"
                    >
                      <option value="adaptive">adaptive</option>
                      <option value="preferred">preferred</option>
                      <option value="strict">strict</option>
                    </select>
                    <input
                      value={spawnFallbackProviders}
                      onChange={(e) => setSpawnFallbackProviders(e.target.value)}
                      placeholder="fallback providers (claude,codex)"
                      className="kb-surface-raised/5 border kb-border-subtle rounded-lg px-3 py-1.5 text-[10px] outline-none"
                    />
                  </div>
                  <div className="text-[9px] opacity-35 font-mono">
                    routing strategy {spawnProviderStrategy}
                    {spawnFallbackProviders.trim() ? ` · fallback ${spawnFallbackProviders}` : ''}
                  </div>
                </>
              )}

              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowSpawn(false)}
                  className="px-3 py-1.5 text-[10px] opacity-40 hover:opacity-80 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSpawn}
                  disabled={spawning || (spawnMode === 'manifest' && !selectedManifest)}
                  className="px-4 py-1.5 kb-status-warning-surface border kb-status-warning-border rounded-lg text-[10px] font-bold uppercase tracking-widest hover:kb-status-warning-surface transition disabled:opacity-20"
                >
                  {spawning ? 'Booting...' : 'Spawn'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t kb-border-subtle flex justify-between items-center">
          <div className="text-[9px] opacity-30 font-mono">
            {health.total} agent{health.total !== 1 ? 's' : ''} registered
            {manifests.length > 0 && ` · ${manifests.length} manifests`}
            {` · ${accessRole}`}
          </div>
          {!showSpawn && accessRole === 'localadmin' && (
            <button
              onClick={() => {
                setShowSpawn(true);
                setSpawnMode('manifest');
                setSelectedManifest('');
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 kb-status-warning-surface border kb-status-warning-border rounded-lg text-[10px] font-bold uppercase tracking-widest hover:kb-status-warning-surface transition"
            >
              <Plus size={12} /> Spawn Agent
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
