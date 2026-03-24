"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, RefreshCw, Cpu, X, FileText, Terminal, RotateCcw } from "lucide-react";
import { resolveChronosLocale, uxText } from "../lib/ux-vocabulary";

interface AgentRecord {
  agentId: string;
  provider: string;
  modelId: string;
  status: string;
  capabilities: string[];
  trustScore: number | null;
  uptimeMs: number | null;
  idleMs: number | null;
  runtime: {
    kind: string;
    state: string;
    pid?: number;
    idleForMs: number;
    shutdownPolicy: string;
  } | null;
  metrics: {
    turnCount: number;
    errorCount: number;
    restartCount: number;
    refreshCount: number;
    totalPromptChars: number;
    totalResponseChars: number;
    usage?: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    };
  } | null;
  process: {
    rssKb?: number;
    cpuPercent?: number;
  } | null;
  supportsSoftRefresh: boolean;
  providerRuntime?: Record<string, unknown>;
}

interface HealthSnapshot {
  total: number;
  ready: number;
  busy: number;
  error: number;
}

type ChronosAccessRole = "readonly" | "localadmin";

interface ManifestEntry {
  agentId: string;
  provider: string;
  modelId: string;
  capabilities: string[];
  trustRequired: number;
  requiresEnv: string[];
}

interface ProviderOption {
  value: string;
  label: string;
  models: string[];
  installed: boolean;
  version: string | null;
  protocol: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Gemini",
  claude: "Claude",
  copilot: "GitHub Copilot",
  codex: "Codex",
};

const STATUS_COLORS: Record<string, string> = {
  ready: "bg-green-500",
  busy: "bg-yellow-500 animate-pulse",
  booting: "bg-blue-500 animate-pulse",
  error: "bg-red-500",
  registered: "bg-gray-500",
  shutdown: "bg-gray-800",
};

export function AgentPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const locale = resolveChronosLocale();
  const at = (key: string, fallbackEn: string) => uxText(key, fallbackEn, locale);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [health, setHealth] = useState<HealthSnapshot>({ total: 0, ready: 0, busy: 0, error: 0 });
  const [accessRole, setAccessRole] = useState<ChronosAccessRole>("readonly");
  const [manifests, setManifests] = useState<ManifestEntry[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [showSpawn, setShowSpawn] = useState(false);
  const [spawnMode, setSpawnMode] = useState<"manifest" | "custom">("manifest");
  const [spawning, setSpawning] = useState(false);
  const [selectedManifest, setSelectedManifest] = useState("");
  const [spawnProvider, setSpawnProvider] = useState("");
  const [spawnModel, setSpawnModel] = useState("");
  const [spawnPrompt, setSpawnPrompt] = useState("");
  const [viewingLogs, setViewingLogs] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ ts: number; type: string; content: string }[]>([]);
  const [mutatingAgent, setMutatingAgent] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (res.ok) {
        const data = await res.json();
        setAgents(data.agents || []);
        setHealth(data);
        setAccessRole(data.accessRole || "readonly");
      }
    } catch (_) {}
  }, []);

  const fetchManifests = useCallback(async () => {
    try {
      const res = await fetch("/api/agents?manifests=true");
      if (res.ok) {
        const data = await res.json();
        setManifests(data.manifests || []);
        setAccessRole(data.accessRole || "readonly");
      }
    } catch (_) {}
  }, []);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/agents?providers=true");
      if (res.ok) {
        const data = await res.json();
        const opts: ProviderOption[] = (data.providers || []).map((p: any) => ({
          value: p.provider,
          label: PROVIDER_LABELS[p.provider] || p.provider,
          models: p.models || [],
          installed: p.installed,
          version: p.installed && p.version && !p.version.includes('Error') ? p.version : null,
          protocol: p.protocol,
        }));
        setProviders(opts);
        setAccessRole(data.accessRole || "readonly");
        // Auto-select first available provider if none selected
        setSpawnProvider((prev) => {
          if (prev) return prev;
          const first = opts.find(p => p.installed);
          if (first) {
            if (first.models.length > 0) setSpawnModel(first.models[0]);
            return first.value;
          }
          return prev;
        });
      }
    } catch (_) {}
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
      if (spawnMode === "manifest" && selectedManifest) {
        // Spawn from manifest — just pass agentId, backend loads config from .agent.md
        const m = manifests.find(m => m.agentId === selectedManifest);
        body = { agentId: selectedManifest, provider: m?.provider || "gemini" };
      } else {
        body = {
          provider: spawnProvider,
          modelId: spawnModel,
          systemPrompt: spawnPrompt || undefined,
        };
      }

      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setShowSpawn(false);
        setSpawnPrompt("");
        await fetchAgents();
      } else {
        const err = await res.json();
        alert(err.error || "Spawn failed");
      }
    } catch (_) {}
    setSpawning(false);
  };

  const fetchLogs = async (agentId: string) => {
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logs", agentId, limit: 100 }),
      });
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch (_) {}
  };

  const handleViewLogs = (agentId: string) => {
    setViewingLogs(agentId);
    fetchLogs(agentId);
  };

  const handleShutdown = async (agentId: string) => {
    try {
      setMutatingAgent(agentId);
      await fetch("/api/agents", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      await fetchAgents();
    } catch (_) {}
    setMutatingAgent(null);
  };

  const handleAgentAction = async (agentId: string, action: "refresh" | "restart") => {
    try {
      setMutatingAgent(agentId);
      await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, agentId }),
      });
      await fetchAgents();
      if (viewingLogs === agentId) {
        await fetchLogs(agentId);
      }
    } catch (_) {}
    setMutatingAgent(null);
  };

  if (!isOpen) return null;

  // Filter out already-running agents from manifest list
  const runningIds = new Set(agents.map(a => a.agentId));
  const availableManifests = manifests.filter(m => !runningIds.has(m.agentId));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[600px] max-h-[80vh] kyberion-glass rounded-2xl border border-kyberion-gold/20 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <div className="flex items-center gap-3">
            <Cpu className="text-kyberion-gold w-5 h-5" />
            <span className="text-sm font-bold uppercase tracking-widest">{at("chronos_agent_registry", "Agent Registry")}</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex gap-2 text-[9px] font-mono">
              <span className="px-2 py-0.5 rounded bg-green-900/30 text-green-400">{health.ready} ready</span>
              <span className="px-2 py-0.5 rounded bg-yellow-900/30 text-yellow-400">{health.busy} busy</span>
              {health.error > 0 && <span className="px-2 py-0.5 rounded bg-red-900/30 text-red-400">{health.error} error</span>}
            </div>
            <button onClick={fetchAgents} className="opacity-40 hover:opacity-80 transition">
              <RefreshCw size={14} />
            </button>
            <button onClick={onClose} className="opacity-40 hover:opacity-80 transition">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Agent List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {agents.length === 0 && !showSpawn && (
            <div className="text-center text-[11px] opacity-30 italic py-8">
              {at("chronos_no_agents_running", "No agents running. Spawn one to get started.")}
            </div>
          )}
          {agents.map((agent) => (
            <div key={agent.agentId} className="flex items-center gap-3 p-3 bg-black/30 rounded-xl border border-white/5">
              {(() => {
                const metrics = agent.metrics || {
                  turnCount: 0,
                  errorCount: 0,
                  restartCount: 0,
                  refreshCount: 0,
                  totalPromptChars: 0,
                  totalResponseChars: 0,
                };
                const idleSeconds = Math.round(((agent.runtime?.idleForMs ?? agent.idleMs) || 0) / 1000);
                const trustLabel = typeof agent.trustScore === "number" ? agent.trustScore : "n/a";
                return (
                  <>
              <div className={`w-2.5 h-2.5 rounded-full ${STATUS_COLORS[agent.status] || "bg-gray-500"}`} />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-bold font-mono truncate">{agent.agentId}</div>
                <div className="text-[9px] opacity-40 flex gap-3 mt-0.5">
                  <span>{agent.provider}/{agent.modelId}</span>
                  <span>Trust: {trustLabel}</span>
                  {agent.capabilities.length > 0 && <span>[{agent.capabilities.join(", ")}]</span>}
                </div>
                <div className="text-[8px] opacity-35 flex flex-wrap gap-3 mt-1 font-mono">
                  <span>turns {metrics.turnCount}</span>
                  <span>errors {metrics.errorCount}</span>
                  <span>refresh {metrics.refreshCount}</span>
                  <span>restart {metrics.restartCount}</span>
                  <span>idle {idleSeconds}s</span>
                  {typeof agent.process?.rssKb === "number" && <span>rss {(agent.process.rssKb / 1024).toFixed(1)}MB</span>}
                  {typeof metrics.usage?.totalTokens === "number" && <span>tokens {metrics.usage.totalTokens}</span>}
                </div>
              </div>
              <div className="text-[8px] uppercase tracking-widest opacity-40">{agent.status}</div>
              <button
                onClick={() => handleAgentAction(agent.agentId, "refresh")}
                disabled={accessRole !== "localadmin" || mutatingAgent === agent.agentId || !agent.supportsSoftRefresh}
                className="p-1.5 rounded-lg hover:bg-emerald-900/30 text-emerald-400/40 hover:text-emerald-400 transition disabled:opacity-20"
                title={agent.supportsSoftRefresh ? "Soft refresh context" : "Soft refresh unsupported"}
              >
                <RefreshCw size={12} />
              </button>
              <button
                onClick={() => handleAgentAction(agent.agentId, "restart")}
                disabled={accessRole !== "localadmin" || mutatingAgent === agent.agentId}
                className="p-1.5 rounded-lg hover:bg-amber-900/30 text-amber-400/40 hover:text-amber-400 transition disabled:opacity-20"
                title="Restart agent runtime"
              >
                <RotateCcw size={12} />
              </button>
              <button
                onClick={() => handleViewLogs(agent.agentId)}
                className="p-1.5 rounded-lg hover:bg-blue-900/30 text-blue-400/40 hover:text-blue-400 transition"
                title="View terminal logs"
              >
                <Terminal size={12} />
              </button>
              <button
                onClick={() => handleShutdown(agent.agentId)}
                disabled={accessRole !== "localadmin" || mutatingAgent === agent.agentId}
                className="p-1.5 rounded-lg hover:bg-red-900/30 text-red-400/40 hover:text-red-400 transition disabled:opacity-20"
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
            <div className="p-4 bg-black/60 rounded-xl border border-blue-500/20 space-y-2">
              <div className="flex justify-between items-center">
                <div className="text-[10px] font-bold uppercase tracking-widest opacity-60 flex items-center gap-2">
                  <Terminal size={12} /> {viewingLogs}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => fetchLogs(viewingLogs)} className="text-[9px] text-blue-400 hover:text-blue-300">{at("chronos_refresh", "Refresh")}</button>
                  <button onClick={() => setViewingLogs(null)} className="text-[9px] opacity-40 hover:opacity-80">{at("chronos_close", "Close")}</button>
                </div>
              </div>
              <div className="max-h-[250px] overflow-y-auto font-mono text-[9px] space-y-0.5 bg-black/40 rounded-lg p-3">
                {logs.length === 0 ? (
                  <div className="text-center opacity-30 italic py-4">{at("chronos_no_logs_yet", "No logs yet. Send a message to this agent first.")}</div>
                ) : logs.map((entry, i) => {
                  const typeColors: Record<string, string> = {
                    agent: 'text-green-400', prompt: 'text-blue-400', out: 'text-cyan-400',
                    in: 'text-gray-400', stderr: 'text-red-400', text: 'text-yellow-400',
                  };
                  const time = new Date(entry.ts).toLocaleTimeString();
                  return (
                    <div key={i} className={`${typeColors[entry.type] || 'opacity-40'} break-all`}>
                      <span className="opacity-40">[{time}]</span>{' '}
                      <span className="opacity-50 uppercase">{entry.type}</span>{' '}
                      {entry.content.slice(0, 200)}{entry.content.length > 200 ? '...' : ''}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Spawn Form */}
          {showSpawn && (
            <div className="p-4 bg-black/40 rounded-xl border border-kyberion-gold/20 space-y-3">
              {/* Mode Toggle */}
              <div className="flex gap-2 mb-2">
                <button
                  onClick={() => setSpawnMode("manifest")}
                  className={`flex-1 py-1.5 rounded-lg text-[9px] uppercase tracking-widest transition border ${
                    spawnMode === "manifest" ? "bg-kyberion-gold/20 border-kyberion-gold/30" : "border-white/5 opacity-40"
                  }`}
                >
                  <FileText size={10} className="inline mr-1" /> {at("chronos_from_manifest", "From Manifest")}
                </button>
                <button
                  onClick={() => setSpawnMode("custom")}
                  className={`flex-1 py-1.5 rounded-lg text-[9px] uppercase tracking-widest transition border ${
                    spawnMode === "custom" ? "bg-kyberion-gold/20 border-kyberion-gold/30" : "border-white/5 opacity-40"
                  }`}
                >
                  <Plus size={10} className="inline mr-1" /> {at("chronos_custom", "Custom")}
                </button>
              </div>

              {spawnMode === "manifest" ? (
                <>
                  <div className="text-[10px] font-bold uppercase tracking-widest opacity-60">{at("chronos_select_agent_definition", "Select Agent Definition")}</div>
                  {availableManifests.length === 0 ? (
                    <div className="text-[10px] opacity-30 italic">{at("chronos_all_agents_running", "All defined agents are already running.")}</div>
                  ) : (
                    <div className="space-y-1">
                      {availableManifests.map((m) => (
                        <button
                          key={m.agentId}
                          onClick={() => setSelectedManifest(m.agentId)}
                          className={`w-full text-left p-3 rounded-lg border transition ${
                            selectedManifest === m.agentId
                              ? "border-kyberion-gold/30 bg-kyberion-gold/10"
                              : "border-white/5 hover:border-white/10"
                          }`}
                        >
                          <div className="text-[10px] font-bold font-mono">{m.agentId}</div>
                          <div className="text-[9px] opacity-40 flex gap-3 mt-0.5">
                            <span>{m.provider}/{m.modelId}</span>
                            {m.capabilities.length > 0 && <span>[{m.capabilities.join(", ")}]</span>}
                            {m.requiresEnv.length > 0 && (
                              <span className="text-yellow-500">needs: {m.requiresEnv.join(", ")}</span>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="text-[10px] font-bold uppercase tracking-widest opacity-60">Custom Agent</div>
                  {providers.filter(p => p.installed).length === 0 ? (
                    <div className="text-[10px] opacity-30 italic">Scanning providers...</div>
                  ) : (
                    <div className="flex gap-2">
                      <select
                        value={spawnProvider}
                        onChange={(e) => {
                          setSpawnProvider(e.target.value);
                          const pc = providers.find(p => p.value === e.target.value);
                          if (pc && pc.models.length > 0) setSpawnModel(pc.models[0]);
                        }}
                        className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-[10px] outline-none"
                      >
                        {providers.filter(p => p.installed).map(p => (
                          <option key={p.value} value={p.value}>
                            {p.label} {p.version ? `(${p.version})` : ''} [{p.protocol}]
                          </option>
                        ))}
                      </select>
                      <select
                        value={spawnModel}
                        onChange={(e) => setSpawnModel(e.target.value)}
                        className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-[10px] outline-none"
                      >
                        {(providers.find(p => p.value === spawnProvider)?.models || []).map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {/* Show unavailable providers */}
                  {providers.filter(p => !p.installed).length > 0 && (
                    <div className="text-[9px] opacity-30 mt-1">
                      Not installed: {providers.filter(p => !p.installed).map(p => p.label).join(', ')}
                    </div>
                  )}
                  <textarea
                    value={spawnPrompt}
                    onChange={(e) => setSpawnPrompt(e.target.value)}
                    placeholder="System prompt (optional)..."
                    rows={2}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[10px] outline-none resize-none"
                  />
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
                  disabled={spawning || (spawnMode === "manifest" && !selectedManifest)}
                  className="px-4 py-1.5 bg-kyberion-gold/20 border border-kyberion-gold/20 rounded-lg text-[10px] font-bold uppercase tracking-widest hover:bg-kyberion-gold/30 transition disabled:opacity-20"
                >
                  {spawning ? "Booting..." : "Spawn"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/5 flex justify-between items-center">
          <div className="text-[9px] opacity-30 font-mono">
              {health.total} agent{health.total !== 1 ? "s" : ""} registered
              {manifests.length > 0 && ` · ${manifests.length} manifests`}
              {` · ${accessRole}`}
            </div>
          {!showSpawn && accessRole === "localadmin" && (
            <button
              onClick={() => { setShowSpawn(true); setSpawnMode("manifest"); setSelectedManifest(""); }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-kyberion-gold/20 border border-kyberion-gold/20 rounded-lg text-[10px] font-bold uppercase tracking-widest hover:bg-kyberion-gold/30 transition"
            >
              <Plus size={12} /> Spawn Agent
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
