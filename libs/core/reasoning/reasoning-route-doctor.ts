import { discoverProviders } from '../provider/provider-discovery.js';
import { nowIso } from '../foundation/time.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { getReasoningProviderDescriptor } from './reasoning-provider-registry.js';
import {
  probeReasoningProviderReadiness,
  type ReasoningProviderReadinessDeps,
} from './reasoning-provider-readiness.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import {
  loadReasoningRoutePolicy,
  resolveReasoningRoute,
  type ResolvedReasoningRoute,
} from './reasoning-route-resolver.js';

export type ReasoningRouteDoctorStatus =
  'ready' | 'degraded' | 'not_configured' | 'unavailable' | 'invalid';

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

export interface ReasoningRouteDoctorOptions {
  /**
   * Perform live credential probes (e.g. Anthropic `GET /v1/models`). Off by
   * default: the doctor runs on every operator-surface reasoning page load
   * and `pnpm reasoning:config doctor`, so it only checks that the key is
   * configured unless the operator asks for `--live`.
   */
  live?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Test seam for the readiness probes. */
  readinessDeps?: ReasoningProviderReadinessDeps;
}

const ANTHROPIC_KEY_PRESENT_REASON = 'ANTHROPIC_API_KEY configured; live call not consumed';

/** Key-presence check used instead of a live API call when `live` is off. */
function anthropicKeyPresenceProbe(
  env: NodeJS.ProcessEnv
): Promise<{ available: boolean; reason?: string }> {
  return Promise.resolve(
    getRegisteredEnvText('ANTHROPIC_API_KEY', { env })?.trim()
      ? { available: true }
      : { available: false, reason: 'ANTHROPIC_API_KEY is not configured' }
  );
}

/** Adapters whose readiness is answered by provider discovery (no live spawn here). */
const DISCOVERY_ADAPTERS = new Set(['provider-cli', 'claude-cli', 'claude-agent-sdk']);

/**
 * RS-03: probe selection is driven by the governed descriptor's adapter, not
 * per-mode branches. CLI-family adapters reuse provider discovery; every
 * other adapter uses the shared readiness probe. An unknown mode is reported
 * as unavailable with an explicit reason.
 */
export async function probeReasoningRouteMode(
  mode: string,
  options: ReasoningRouteDoctorOptions = {}
): Promise<{ status: ReasoningRouteDoctorStatus; reason: string }> {
  const descriptor = getReasoningProviderDescriptor(mode as ReasoningBackendMode);
  if (!descriptor) {
    return { status: 'unavailable', reason: `No governed reasoning provider for mode ${mode}` };
  }
  if (descriptor.adapter === 'stub') {
    return { status: 'ready', reason: 'deterministic stub available' };
  }
  if (DISCOVERY_ADAPTERS.has(descriptor.adapter)) {
    const provider = descriptor.provider;
    const entry = discoverProviders(false).find((candidate) => candidate.provider === provider);
    return entry?.healthy
      ? { status: 'ready', reason: `${provider} CLI healthy` }
      : { status: 'not_configured', reason: `${provider} CLI is not installed or healthy` };
  }
  const deps: ReasoningProviderReadinessDeps = options.live
    ? { ...options.readinessDeps }
    : { ...options.readinessDeps, anthropicProbe: anthropicKeyPresenceProbe };
  const result = await probeReasoningProviderReadiness(
    descriptor,
    options.env ?? process.env,
    deps
  );
  if (result.available && !options.live && descriptor.adapter === 'anthropic-api') {
    return { status: 'ready', reason: ANTHROPIC_KEY_PRESENT_REASON };
  }
  return result.available
    ? { status: 'ready', reason: 'endpoint reachable; model-specific completion not consumed' }
    : { status: 'not_configured', reason: result.reason || 'endpoint probe failed' };
}

async function inspectRole(
  role: string,
  options: ReasoningRouteDoctorOptions,
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
        pending = probeReasoningRouteMode(candidateRoute.mode, options);
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

export async function inspectReasoningRoutes(
  options: ReasoningRouteDoctorOptions = {}
): Promise<ReasoningRouteDoctorReport> {
  const roles = Object.keys(loadReasoningRoutePolicy().roles);
  const probeCache = new Map<
    string,
    Promise<{ status: ReasoningRouteDoctorStatus; reason: string }>
  >();
  const entries = await Promise.all(roles.map((role) => inspectRole(role, options, probeCache)));
  const nextActions = Array.from(
    new Set(
      entries.flatMap((entry) => {
        if (entry.status === 'ready') return [];
        if (entry.status === 'degraded')
          return [`Review degraded primary route for role ${entry.role}: ${entry.reason}`];
        const setupHint = entry.mode
          ? getReasoningProviderDescriptor(entry.mode as ReasoningBackendMode)?.setup_hint
          : undefined;
        if (setupHint) return [setupHint];
        return [`Repair route for role ${entry.role}: ${entry.reason}`];
      })
    )
  );
  return {
    valid: entries.every((entry) => entry.status === 'ready' || entry.status === 'degraded'),
    checkedAt: nowIso(),
    entries,
    nextActions,
  };
}
