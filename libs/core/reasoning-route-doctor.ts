import { discoverProviders } from './provider-discovery.js';
import {
  probeLmStudioBackendAvailability,
  probeLlamaCppBackendAvailability,
  probeLocalAiBackendAvailability,
  probeMlxBackendAvailability,
  probeNemotronBackendAvailability,
  probeOllamaBackendAvailability,
  probeOpenAiCompatibleBackendAvailability,
  probeVllmBackendAvailability,
} from './openai-compatible-backend.js';
import { probeOpenRouterBackendAvailability } from './openrouter-backend.js';
import {
  loadReasoningRoutePolicy,
  resolveReasoningRoute,
  type ResolvedReasoningRoute,
} from './reasoning-route-resolver.js';

export type ReasoningRouteDoctorStatus =
  | 'ready'
  | 'degraded'
  | 'not_configured'
  | 'unavailable'
  | 'invalid';

export interface ReasoningRouteDoctorEntry {
  role: string;
  profileRef?: string;
  mode?: string;
  model?: string;
  status: ReasoningRouteDoctorStatus;
  reason: string;
  candidates?: string[];
  capabilities?: string[];
  toolsEnabled?: boolean;
}

export interface ReasoningRouteDoctorReport {
  valid: boolean;
  checkedAt: string;
  entries: ReasoningRouteDoctorEntry[];
  nextActions: string[];
}

function cliProviderForMode(mode: string): string | undefined {
  return (
    {
      'codex-cli': 'codex',
      'agy-cli': 'agy',
      'claude-cli': 'claude',
      'claude-agent': 'claude',
      'gemini-cli': 'gemini',
      copilot: 'copilot',
    } as Record<string, string>
  )[mode];
}

async function probeMode(
  mode: string
): Promise<{ status: ReasoningRouteDoctorStatus; reason: string }> {
  if (mode === 'stub') return { status: 'ready', reason: 'deterministic stub available' };
  if (mode === 'anthropic') {
    return process.env.ANTHROPIC_API_KEY?.trim()
      ? { status: 'ready', reason: 'ANTHROPIC_API_KEY configured; live call not consumed' }
      : { status: 'not_configured', reason: 'ANTHROPIC_API_KEY is not configured' };
  }
  const provider = cliProviderForMode(mode);
  if (provider) {
    const entry = discoverProviders(false).find((candidate) => candidate.provider === provider);
    return entry?.healthy
      ? { status: 'ready', reason: `${provider} CLI healthy` }
      : { status: 'not_configured', reason: `${provider} CLI is not installed or healthy` };
  }
  const probes: Record<string, () => Promise<{ available: boolean; reason?: string }>> = {
    local: probeOpenAiCompatibleBackendAvailability,
    ollama: probeOllamaBackendAvailability,
    vllm: probeVllmBackendAvailability,
    lmstudio: probeLmStudioBackendAvailability,
    llamacpp: probeLlamaCppBackendAvailability,
    mlx: probeMlxBackendAvailability,
    localai: probeLocalAiBackendAvailability,
    'nemotron-api': probeNemotronBackendAvailability,
    openrouter: probeOpenRouterBackendAvailability,
  };
  const probe = probes[mode];
  if (!probe)
    return { status: 'unavailable', reason: `No doctor probe registered for mode ${mode}` };
  const result = await probe();
  return result.available
    ? { status: 'ready', reason: 'endpoint reachable; model-specific completion not consumed' }
    : { status: 'not_configured', reason: result.reason || 'endpoint probe failed' };
}

async function inspectRole(
  role: string,
  probeCache: Map<string, Promise<{ status: ReasoningRouteDoctorStatus; reason: string }>>
): Promise<ReasoningRouteDoctorEntry> {
  let route: ResolvedReasoningRoute;
  try {
    route = resolveReasoningRoute({ role });
  } catch (error) {
    return {
      role,
      status: 'invalid',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const candidateResults: Array<{
    route: ResolvedReasoningRoute;
    status: ReasoningRouteDoctorStatus;
    reason: string;
  }> = [];
  for (const candidate of route.candidates) {
    try {
      const candidateRoute = resolveReasoningRoute({ role, requestedProfile: candidate });
      let pending = probeCache.get(candidateRoute.mode);
      if (!pending) {
        pending = probeMode(candidateRoute.mode);
        probeCache.set(candidateRoute.mode, pending);
      }
      const probe = await pending;
      candidateResults.push({ route: candidateRoute, ...probe });
      if (probe.status === 'ready') break;
    } catch (error) {
      candidateResults.push({
        route,
        status: 'invalid',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const effective = candidateResults.find((candidate) => candidate.status === 'ready');
  const primary = candidateResults[0];
  const probe = effective ||
    primary || {
      route,
      status: 'unavailable' as const,
      reason: 'No fallback candidate was probeable',
    };
  const degraded = Boolean(
    effective && primary && effective.route.profileRef !== primary.route.profileRef
  );
  return {
    role,
    profileRef: probe.route.profileRef,
    mode: probe.route.mode,
    model: probe.route.model,
    status: degraded ? 'degraded' : probe.status,
    reason: degraded
      ? `Primary ${primary?.route.profileRef} unavailable; using ${effective?.route.profileRef}: ${effective?.reason}`
      : probe.reason,
    candidates: route.candidates,
    capabilities: probe.route.capabilities,
    toolsEnabled: probe.route.toolsEnabled,
  };
}

export async function inspectReasoningRoutes(): Promise<ReasoningRouteDoctorReport> {
  const roles = Object.keys(loadReasoningRoutePolicy().roles);
  const probeCache = new Map<
    string,
    Promise<{ status: ReasoningRouteDoctorStatus; reason: string }>
  >();
  const entries = await Promise.all(roles.map((role) => inspectRole(role, probeCache)));
  const nextActions = Array.from(
    new Set(
      entries.flatMap((entry) => {
        if (entry.status === 'ready') return [];
        if (entry.status === 'degraded')
          return [`Review degraded primary route for role ${entry.role}: ${entry.reason}`];
        if (entry.mode === 'ollama')
          return ['Configure KYBERION_OLLAMA_URL and confirm the selected model is loaded.'];
        if (entry.mode === 'vllm')
          return ['Configure KYBERION_VLLM_URL and confirm the selected model is loaded.'];
        if (entry.mode === 'openrouter')
          return ['Configure OPENROUTER_API_KEY or KYBERION_OPENROUTER_KEY.'];
        if (entry.mode === 'anthropic') return ['Configure ANTHROPIC_API_KEY.'];
        return [`Repair route for role ${entry.role}: ${entry.reason}`];
      })
    )
  );
  return {
    valid: entries.every((entry) => entry.status === 'ready' || entry.status === 'degraded'),
    checkedAt: new Date().toISOString(),
    entries,
    nextActions,
  };
}
