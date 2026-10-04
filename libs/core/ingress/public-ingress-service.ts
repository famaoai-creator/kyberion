/**
 * Public ingress service — the caller-facing API (CLI, surfaces, doctor).
 *
 * Exposes a surface only when its manifest opts in (`ingress.allowed`), the
 * process answering on the manifest port identifies as that surface, and a
 * human approved `ingress:expose`. Provider choice goes through the resolver;
 * this module never branches on a provider id.
 *
 * Exposures are recorded under active/shared/runtime/ingress/state.json
 * (system partition: surface id, provider id, public URL — no tenant data)
 * and audited as ingress_expose / ingress_withdraw. That record is
 * per-checkout while provider config is host-wide, so `withdraw` / `status`
 * always ask the provider: without a record they query every candidate
 * provider for a live mapping to this surface's loopback target, and they
 * never report "not exposed" without having checked.
 */
import { createHash } from 'node:crypto';
import { auditChain } from '../governance/audit-chain.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { isRecord } from '../foundation/primitives.js';
import { pathResolver } from '../path-resolver.js';
import { requireApprovalForOp, RISKY_OPS } from '../risky-op-registry.js';
import { loadSurfaceManifest, type SurfaceRuntimeDefinition } from '../surface/surface-runtime.js';
import {
  IngressError,
  assertIngressLocalPort,
  normalizeIngressPathPrefix,
  type IngressExposure,
  type PublicIngressProvider,
} from './public-ingress-contract.js';
import {
  getPublicIngressProviderDescriptor,
  listPublicIngressCandidates,
  listPublicIngressProviderDescriptors,
  loadPublicIngressProvider,
  selectPublicIngressProvider,
  type PublicIngressCandidate,
  type PublicIngressSelection,
} from './public-ingress-provider-registry.js';

export const PUBLIC_INGRESS_STATE_RELATIVE_PATH = 'runtime/ingress/state.json';
/** Approval for one surface/provider/effect is renewable after this long. */
export const PUBLIC_INGRESS_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const IDENTITY_PROBE_TIMEOUT_MS = 1500;

export interface PublicIngressState {
  version: 1;
  exposures: Record<string, IngressExposure>;
}

export interface SurfaceIdentityProbe {
  ok: boolean;
  detail: string;
}

export interface PublicIngressServiceDeps {
  statePath?: string;
  loadSurfaces?: () => SurfaceRuntimeDefinition[];
  /** Verify the process on the manifest port is this surface (default: GET healthPath). */
  probeIdentity?: (
    surface: SurfaceRuntimeDefinition,
    plan: SurfaceIngressPlan
  ) => Promise<SurfaceIdentityProbe>;
  approve?: typeof requireApprovalForOp;
  now?: () => Date;
}

export function publicIngressStatePath(deps: PublicIngressServiceDeps = {}): string {
  return deps.statePath ?? pathResolver.shared(PUBLIC_INGRESS_STATE_RELATIVE_PATH);
}

export function loadPublicIngressState(deps: PublicIngressServiceDeps = {}): PublicIngressState {
  const state = readJsonIfPresent<PublicIngressState>(publicIngressStatePath(deps));
  if (!state || state.version !== 1 || typeof state.exposures !== 'object' || !state.exposures) {
    return { version: 1, exposures: {} };
  }
  return state;
}

function savePublicIngressState(state: PublicIngressState, deps: PublicIngressServiceDeps): void {
  writeJson(publicIngressStatePath(deps), state);
}

function loadSurfaces(deps: PublicIngressServiceDeps): SurfaceRuntimeDefinition[] {
  return deps.loadSurfaces ? deps.loadSurfaces() : loadSurfaceManifest().surfaces;
}

/** Resolve a surface by id; `event-intake` also matches `event-intake-surface`. */
export function resolveIngressSurface(
  surfaceId: string,
  deps: PublicIngressServiceDeps = {}
): SurfaceRuntimeDefinition {
  const id = surfaceId.trim();
  const surfaces = loadSurfaces(deps);
  const surface =
    surfaces.find((entry) => entry.id === id) ??
    surfaces.find((entry) => entry.id === `${id}-surface`);
  if (!surface) {
    throw new IngressError('INGRESS_INVALID_REQUEST', `unknown surface '${surfaceId}'`);
  }
  return surface;
}

export interface SurfaceIngressPlan {
  localPort: number;
  pathPrefix: string;
  healthPath?: string;
}

/** The exposure plan for a surface, or the reason it may not be exposed. */
export function planSurfaceIngress(surface: SurfaceRuntimeDefinition): SurfaceIngressPlan {
  if (surface.ingress?.allowed !== true) {
    throw new IngressError(
      'INGRESS_SURFACE_NOT_ALLOWED',
      `surface '${surface.id}' does not opt in to public ingress (manifest ingress.allowed is not true)`
    );
  }
  if (surface.port === undefined) {
    throw new IngressError(
      'INGRESS_SURFACE_NOT_ALLOWED',
      `surface '${surface.id}' declares no local port`
    );
  }
  const localPort = assertIngressLocalPort(surface.port);
  const portEnv = surface.ingress.port_env;
  const override = portEnv ? getRegisteredEnvText(portEnv)?.trim() : undefined;
  if (portEnv && override && Number(override) !== localPort) {
    throw new IngressError(
      'INGRESS_SURFACE_NOT_ALLOWED',
      `${portEnv}=${override} differs from the manifest port ${localPort} of '${surface.id}'; align them so the exposed port is the surface's`
    );
  }
  return {
    localPort,
    pathPrefix: normalizeIngressPathPrefix(surface.ingress.path_prefix),
    ...(surface.healthPath ? { healthPath: surface.healthPath } : {}),
  };
}

/**
 * Default identity probe: GET 127.0.0.1:<port><healthPath> must answer 2xx
 * with JSON `service` equal to the surface id, so a different process that
 * happens to hold the port is never published.
 */
export async function probeSurfaceIdentity(
  surface: SurfaceRuntimeDefinition,
  plan: SurfaceIngressPlan
): Promise<SurfaceIdentityProbe> {
  if (!plan.healthPath) return { ok: false, detail: 'surface declares no healthPath' };
  const url = `http://127.0.0.1:${plan.localPort}${plan.healthPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IDENTITY_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, detail: `http_${response.status}` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, detail: 'health response is not JSON' };
    }
    const service = isRecord(body) && typeof body.service === 'string' ? body.service : undefined;
    return service === surface.id
      ? { ok: true, detail: `service=${service}` }
      : {
          ok: false,
          detail: `health identifies as '${service ?? 'unknown'}', not '${surface.id}'`,
        };
  } catch (error) {
    return {
      ok: false,
      detail: (error as Error)?.name === 'AbortError' ? 'timeout' : 'connect_failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Short digest of the effect an approval covers (port, prefix, provider, network). */
export function ingressEffectDigest(effect: {
  provider_id: string;
  local_port: number;
  path_prefix: string;
  network_class: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        effect.provider_id,
        effect.local_port,
        effect.path_prefix,
        effect.network_class,
      ])
    )
    .digest('hex')
    .slice(0, 12);
}

export type IngressApprovalState =
  'created' | 'pending' | 'rejected' | 'expired' | 'effect_mismatch' | 'human_required' | 'unknown';

export type ExposeSurfaceResult =
  | {
      status: 'exposed';
      exposure: IngressExposure;
      selection: Omit<PublicIngressSelection, 'provider'>;
    }
  | {
      status: 'approval_required';
      approval_state: IngressApprovalState;
      approval_request_id?: string;
      message: string;
      provider_id: string;
      selection: Omit<PublicIngressSelection, 'provider'>;
    };

function selectionSummary(
  selection: PublicIngressSelection
): Omit<PublicIngressSelection, 'provider'> {
  const { provider: _provider, ...rest } = selection;
  return rest;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function exposeSurface(
  options: { surfaceId: string; providerId?: string; agentId?: string },
  deps: PublicIngressServiceDeps = {}
): Promise<ExposeSurfaceResult> {
  const agentId = options.agentId ?? 'kyberion:ingress';
  const surface = resolveIngressSurface(options.surfaceId, deps);
  const plan = planSurfaceIngress(surface);

  const identity = await (deps.probeIdentity ?? probeSurfaceIdentity)(surface, plan);
  if (!identity.ok) {
    throw new IngressError(
      'INGRESS_SURFACE_UNHEALTHY',
      `surface '${surface.id}' is not serving on 127.0.0.1:${plan.localPort}${plan.healthPath ?? ''} (${identity.detail}); start it before exposing`
    );
  }

  const selection = await selectPublicIngressProvider({ providerId: options.providerId });
  const providerId = selection.candidate.provider_id;
  const effect = {
    provider_id: providerId,
    local_port: plan.localPort,
    path_prefix: plan.pathPrefix,
    network_class: selection.candidate.network_class,
  };
  const approve = deps.approve ?? requireApprovalForOp;
  const now = (deps.now ?? (() => new Date()))();
  const approval = approve({
    opId: RISKY_OPS.INGRESS_EXPOSE,
    agentId,
    // The effect digest makes a changed port/prefix/provider a new request
    // instead of an effect_mismatch against an older approval.
    correlationId: `ingress:expose:${surface.id}:${providerId}:${ingressEffectDigest(effect)}`,
    channel: 'cli',
    payload: {
      surface_id: surface.id,
      ...effect,
      stable_url: selection.candidate.stable_url,
      rationale: `Publish surface ${surface.id} (${plan.pathPrefix}) to the public internet through ${selection.candidate.display_name}.`,
      consequences: [
        `Anyone on the internet can reach 127.0.0.1:${plan.localPort}${plan.pathPrefix === '/' ? '' : plan.pathPrefix}/* on this host.`,
      ],
    },
    draft: {
      title: `Expose ${surface.id} publicly via ${selection.candidate.display_name}`,
      summary: `Publish ${surface.id} at path ${plan.pathPrefix} (${selection.candidate.network_class}).`,
      severity: 'high',
    },
    expiresAt: new Date(now.getTime() + PUBLIC_INGRESS_APPROVAL_TTL_MS).toISOString(),
  });
  if (!approval.allowed) {
    return {
      status: 'approval_required',
      approval_state: approval.requestStatus ?? 'unknown',
      ...(approval.requestId ? { approval_request_id: approval.requestId } : {}),
      message: approval.message ?? `approval required for ${RISKY_OPS.INGRESS_EXPOSE}`,
      provider_id: providerId,
      selection: selectionSummary(selection),
    };
  }

  const auditMetadata = {
    surface_id: surface.id,
    provider_id: providerId,
    path_prefix: plan.pathPrefix,
    local_port: plan.localPort,
    network_class: selection.candidate.network_class,
  };
  let exposure: IngressExposure;
  try {
    exposure = await selection.provider.up({
      surfaceId: surface.id,
      localPort: plan.localPort,
      pathPrefix: plan.pathPrefix,
      ...(plan.healthPath ? { localHealthPath: plan.healthPath } : {}),
    });
  } catch (error) {
    auditChain.record({
      agentId,
      action: 'ingress_expose',
      operation: RISKY_OPS.INGRESS_EXPOSE,
      result: 'failed',
      reason: errorText(error),
      metadata: auditMetadata,
    });
    throw error;
  }
  try {
    const state = loadPublicIngressState(deps);
    state.exposures[surface.id] = exposure;
    savePublicIngressState(state, deps);
  } catch (error) {
    // The mapping is live but unrecorded; status/down still find it through
    // the provider, so report rather than tear it down.
    auditChain.record({
      agentId,
      action: 'ingress_expose',
      operation: RISKY_OPS.INGRESS_EXPOSE,
      result: 'error',
      reason: `exposed but state write failed: ${errorText(error)}`,
      metadata: { ...auditMetadata, public_url: exposure.public_url },
    });
    throw new IngressError(
      'INGRESS_COMMAND_FAILED',
      `${surface.id} is exposed at ${exposure.public_url} but the state record could not be written (${errorText(error)}); \`ingress status\` / \`ingress down\` still find it through the provider`,
      providerId
    );
  }
  auditChain.record({
    agentId,
    action: 'ingress_expose',
    operation: RISKY_OPS.INGRESS_EXPOSE,
    result: 'completed',
    reason: `${selection.route}: ${selection.reason}`,
    metadata: { ...auditMetadata, public_url: exposure.public_url },
  });
  return { status: 'exposed', exposure, selection: selectionSummary(selection) };
}

async function providerForId(providerId: string): Promise<PublicIngressProvider> {
  const descriptor = getPublicIngressProviderDescriptor(providerId);
  if (!descriptor) {
    throw new IngressError(
      'INGRESS_PROVIDER_UNKNOWN',
      `unknown ingress provider '${providerId}'`,
      providerId
    );
  }
  if (descriptor.status !== 'live') {
    throw new IngressError(
      'INGRESS_PROVIDER_NOT_READY',
      `'${providerId}' is ${descriptor.status}, not a live provider`,
      providerId
    );
  }
  return loadPublicIngressProvider(descriptor);
}

/**
 * Providers to inspect for a surface without a local record: the explicit one
 * (argument or KYBERION_INGRESS_PROVIDER), else every live provider.
 */
function candidateProviderIds(providerId?: string): string[] {
  const explicit = providerId?.trim() || getRegisteredEnvText('KYBERION_INGRESS_PROVIDER')?.trim();
  if (explicit) return [explicit];
  return listPublicIngressProviderDescriptors()
    .filter((descriptor) => descriptor.status === 'live')
    .map((descriptor) => descriptor.provider_id);
}

function surfaceTarget(surface: SurfaceRuntimeDefinition): {
  localPort: number;
  pathPrefix: string;
} {
  const plan = planSurfaceIngress(surface);
  return { localPort: plan.localPort, pathPrefix: plan.pathPrefix };
}

export interface WithdrawSurfaceResult {
  status: 'withdrawn' | 'not_exposed';
  exposure?: IngressExposure;
  /** True when the withdrawn mapping had no local state record. */
  unrecorded?: boolean;
  /** Providers that were asked (not_exposed is only reported after asking). */
  checked_providers: string[];
}

/** Withdraw a surface's exposure; with no record, find it through the providers first. */
export async function withdrawSurface(
  options: { surfaceId: string; providerId?: string; agentId?: string },
  deps: PublicIngressServiceDeps = {}
): Promise<WithdrawSurfaceResult> {
  const agentId = options.agentId ?? 'kyberion:ingress';
  const surface = resolveIngressSurface(options.surfaceId, deps);
  const state = loadPublicIngressState(deps);
  const recorded = state.exposures[surface.id];

  let providerId: string | undefined;
  let target: { localPort: number; pathPrefix: string };
  let live: IngressExposure | undefined;
  const checked: string[] = [];
  if (recorded) {
    providerId = recorded.provider_id;
    target = { localPort: recorded.local_port, pathPrefix: recorded.path_prefix };
  } else {
    target = surfaceTarget(surface);
    for (const id of candidateProviderIds(options.providerId)) {
      checked.push(id);
      const provider = await providerForId(id);
      live = await provider.status({ surfaceId: surface.id, ...target });
      if (live) {
        providerId = id;
        break;
      }
    }
    if (!providerId) return { status: 'not_exposed', checked_providers: checked };
  }

  const provider = await providerForId(providerId);
  await provider.down({
    surfaceId: surface.id,
    ...target,
    ...(recorded ? { exposure: recorded } : {}),
  });
  if (recorded) {
    delete state.exposures[surface.id];
    savePublicIngressState(state, deps);
  }
  const exposure = recorded ?? live;
  auditChain.record({
    agentId,
    action: 'ingress_withdraw',
    operation: 'ingress:withdraw',
    result: 'completed',
    reason: recorded ? 'recorded exposure withdrawn' : 'live unrecorded mapping withdrawn',
    metadata: {
      surface_id: surface.id,
      provider_id: providerId,
      public_url: exposure?.public_url ?? null,
      path_prefix: target.pathPrefix,
      local_port: target.localPort,
    },
  });
  return {
    status: 'withdrawn',
    ...(exposure ? { exposure } : {}),
    ...(recorded ? {} : { unrecorded: true }),
    checked_providers: recorded ? [providerId] : checked,
  };
}

export interface SurfaceIngressStatus {
  surface_id: string;
  provider_id?: string;
  recorded?: IngressExposure;
  /** Live provider view; undefined when the mapping is gone. */
  live?: IngressExposure;
  /**
   * confirmed = recorded and live; unrecorded = live without a local record;
   * missing = recorded but gone; not_exposed = providers checked, nothing
   * live; error = a provider could not be inspected (see detail).
   */
  live_check: 'confirmed' | 'unrecorded' | 'missing' | 'not_exposed' | 'error';
  detail?: string;
}

async function inspectSurface(
  surface: SurfaceRuntimeDefinition,
  recorded: IngressExposure | undefined,
  providerId: string | undefined
): Promise<SurfaceIngressStatus[]> {
  if (recorded) {
    try {
      const provider = await providerForId(recorded.provider_id);
      const live = await provider.status({
        surfaceId: surface.id,
        pathPrefix: recorded.path_prefix,
        localPort: recorded.local_port,
        exposure: recorded,
      });
      return [
        {
          surface_id: surface.id,
          provider_id: recorded.provider_id,
          recorded,
          ...(live ? { live } : {}),
          live_check: live ? 'confirmed' : 'missing',
        },
      ];
    } catch (error) {
      return [
        {
          surface_id: surface.id,
          provider_id: recorded.provider_id,
          recorded,
          live_check: 'error',
          detail: errorText(error),
        },
      ];
    }
  }
  const target = surfaceTarget(surface);
  const providerIds = candidateProviderIds(providerId);
  const results: SurfaceIngressStatus[] = [];
  for (const id of providerIds) {
    try {
      const provider = await providerForId(id);
      const live = await provider.status({ surfaceId: surface.id, ...target });
      if (live) {
        results.push({ surface_id: surface.id, provider_id: id, live, live_check: 'unrecorded' });
      }
    } catch (error) {
      results.push({
        surface_id: surface.id,
        provider_id: id,
        live_check: 'error',
        detail: errorText(error),
      });
    }
  }
  if (results.length === 0) {
    results.push({
      surface_id: surface.id,
      live_check: 'not_exposed',
      detail: `checked ${providerIds.join(', ') || 'no live provider'}`,
    });
  }
  return results;
}

/**
 * Exposure status cross-checked with the providers: recorded surfaces plus
 * every surface that opts in to ingress (a mapping may exist without a record).
 */
export async function listSurfaceIngressStatus(
  options: { surfaceId?: string; providerId?: string } = {},
  deps: PublicIngressServiceDeps = {}
): Promise<SurfaceIngressStatus[]> {
  const state = loadPublicIngressState(deps);
  const targets: SurfaceRuntimeDefinition[] = options.surfaceId
    ? [resolveIngressSurface(options.surfaceId, deps)]
    : loadSurfaces(deps).filter(
        (surface) => surface.ingress?.allowed === true || Boolean(state.exposures[surface.id])
      );
  const sorted = [...targets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const results: SurfaceIngressStatus[] = [];
  for (const surface of sorted) {
    const recorded = state.exposures[surface.id];
    if (!recorded && surface.ingress?.allowed !== true) {
      results.push({
        surface_id: surface.id,
        live_check: 'not_exposed',
        detail: 'surface does not opt in to public ingress',
      });
      continue;
    }
    results.push(...(await inspectSurface(surface, recorded, options.providerId)));
  }
  return results;
}

/** Readiness of every declared provider (resolver-generated, catalog order). */
export function probePublicIngressProviders(): Promise<PublicIngressCandidate[]> {
  return listPublicIngressCandidates();
}

/** Environment probe: at least one live provider is ready. */
export async function probeAnyPublicIngressReady(): Promise<{
  available: boolean;
  reason?: string;
}> {
  const candidates = await listPublicIngressCandidates();
  const ready = candidates.find(
    (candidate) => candidate.status === 'live' && candidate.readiness.status === 'ready'
  );
  if (ready) return { available: true, reason: `${ready.provider_id}: ${ready.readiness.reason}` };
  return {
    available: false,
    reason: candidates
      .map((candidate) => {
        const steps = candidate.readiness.setup_steps?.length
          ? ` — next: ${candidate.readiness.setup_steps.join(' / ')}`
          : '';
        return `${candidate.provider_id}: ${candidate.readiness.status} (${candidate.readiness.reason})${steps}`;
      })
      .join('; '),
  };
}
