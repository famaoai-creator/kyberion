/**
 * Public ingress service — the caller-facing API (CLI, surfaces, doctor).
 *
 * Exposes a surface only when its manifest opts in (`ingress.allowed`), the
 * surface answers its health probe, and a human approved `ingress:expose`.
 * Provider choice goes through the resolver; this module never branches on a
 * provider id. Exposures are recorded under
 * active/shared/runtime/ingress/state.json (system partition: surface id,
 * provider id, public URL — no tenant data) and audited as
 * ingress_expose / ingress_withdraw.
 */
import { auditChain } from '../governance/audit-chain.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import { requireApprovalForOp, RISKY_OPS } from '../risky-op-registry.js';
import {
  loadSurfaceManifest,
  probeSurfaceHealth,
  type SurfaceHealthStatus,
  type SurfaceRuntimeDefinition,
} from '../surface/surface-runtime.js';
import {
  IngressError,
  assertIngressLocalPort,
  normalizeIngressPathPrefix,
  type IngressExposure,
} from './public-ingress-contract.js';
import {
  getPublicIngressProviderDescriptor,
  listPublicIngressCandidates,
  loadPublicIngressProvider,
  selectPublicIngressProvider,
  type PublicIngressCandidate,
  type PublicIngressSelection,
} from './public-ingress-provider-registry.js';

export const PUBLIC_INGRESS_STATE_RELATIVE_PATH = 'runtime/ingress/state.json';
/** Approval for one surface/provider pair is renewable after this long. */
export const PUBLIC_INGRESS_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface PublicIngressState {
  version: 1;
  exposures: Record<string, IngressExposure>;
}

export interface PublicIngressServiceDeps {
  statePath?: string;
  loadSurfaces?: () => SurfaceRuntimeDefinition[];
  probeHealth?: (definition: SurfaceRuntimeDefinition) => Promise<SurfaceHealthStatus>;
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

/** Resolve a surface by id; `event-intake` also matches `event-intake-surface`. */
export function resolveIngressSurface(
  surfaceId: string,
  deps: PublicIngressServiceDeps = {}
): SurfaceRuntimeDefinition {
  const id = surfaceId.trim();
  const surfaces = deps.loadSurfaces ? deps.loadSurfaces() : loadSurfaceManifest().surfaces;
  const surface =
    surfaces.find((entry) => entry.id === id) ??
    surfaces.find((entry) => entry.id === `${id}-surface`);
  if (!surface) {
    throw new IngressError('INGRESS_INVALID_REQUEST', `unknown surface '${surfaceId}'`);
  }
  return surface;
}

/** The exposure plan for a surface, or the reason it may not be exposed. */
export function planSurfaceIngress(surface: SurfaceRuntimeDefinition): {
  localPort: number;
  pathPrefix: string;
  healthPath?: string;
} {
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
  return {
    localPort: assertIngressLocalPort(surface.port),
    pathPrefix: normalizeIngressPathPrefix(surface.ingress.path_prefix),
    ...(surface.healthPath ? { healthPath: surface.healthPath } : {}),
  };
}

export type ExposeSurfaceResult =
  | {
      status: 'exposed';
      exposure: IngressExposure;
      selection: Omit<PublicIngressSelection, 'provider'>;
    }
  | {
      status: 'approval_required';
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

export async function exposeSurface(
  options: { surfaceId: string; providerId?: string; agentId?: string },
  deps: PublicIngressServiceDeps = {}
): Promise<ExposeSurfaceResult> {
  const agentId = options.agentId ?? 'kyberion:ingress';
  const surface = resolveIngressSurface(options.surfaceId, deps);
  const plan = planSurfaceIngress(surface);

  const health = await (deps.probeHealth ?? probeSurfaceHealth)(surface);
  if (health.status !== 'healthy') {
    throw new IngressError(
      'INGRESS_SURFACE_UNHEALTHY',
      `surface '${surface.id}' is not healthy on 127.0.0.1:${plan.localPort}${plan.healthPath ?? ''} (${health.status}: ${health.detail}); start it before exposing`
    );
  }

  const selection = await selectPublicIngressProvider({ providerId: options.providerId });
  const providerId = selection.candidate.provider_id;
  const approve = deps.approve ?? requireApprovalForOp;
  const now = (deps.now ?? (() => new Date()))();
  const approval = approve({
    opId: RISKY_OPS.INGRESS_EXPOSE,
    agentId,
    correlationId: `ingress:expose:${surface.id}:${providerId}`,
    channel: 'cli',
    payload: {
      surface_id: surface.id,
      provider_id: providerId,
      local_port: plan.localPort,
      path_prefix: plan.pathPrefix,
      network_class: selection.candidate.network_class,
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
      ...(approval.requestId ? { approval_request_id: approval.requestId } : {}),
      message: approval.message ?? `approval required for ${RISKY_OPS.INGRESS_EXPOSE}`,
      provider_id: providerId,
      selection: selectionSummary(selection),
    };
  }

  const exposure = await selection.provider.up({
    surfaceId: surface.id,
    localPort: plan.localPort,
    pathPrefix: plan.pathPrefix,
    ...(plan.healthPath ? { localHealthPath: plan.healthPath } : {}),
  });
  const state = loadPublicIngressState(deps);
  state.exposures[surface.id] = exposure;
  savePublicIngressState(state, deps);
  auditChain.record({
    agentId,
    action: 'ingress_expose',
    operation: RISKY_OPS.INGRESS_EXPOSE,
    result: 'completed',
    reason: `${selection.route}: ${selection.reason}`,
    metadata: {
      surface_id: surface.id,
      provider_id: providerId,
      public_url: exposure.public_url,
      path_prefix: exposure.path_prefix,
      local_port: exposure.local_port,
      network_class: selection.candidate.network_class,
    },
  });
  return { status: 'exposed', exposure, selection: selectionSummary(selection) };
}

async function providerForExposure(providerId: string) {
  const descriptor = getPublicIngressProviderDescriptor(providerId);
  if (!descriptor || descriptor.status !== 'live') {
    throw new IngressError(
      'INGRESS_PROVIDER_UNKNOWN',
      `exposure was created by '${providerId}', which is no longer a live provider`,
      providerId
    );
  }
  return loadPublicIngressProvider(descriptor);
}

/** Withdraw a surface's exposure through the provider that created it. */
export async function withdrawSurface(
  options: { surfaceId: string; providerId?: string; agentId?: string },
  deps: PublicIngressServiceDeps = {}
): Promise<{ status: 'withdrawn' | 'not_exposed'; exposure?: IngressExposure }> {
  const agentId = options.agentId ?? 'kyberion:ingress';
  const surface = resolveIngressSurface(options.surfaceId, deps);
  const state = loadPublicIngressState(deps);
  const recorded = state.exposures[surface.id];
  const providerId = recorded?.provider_id ?? options.providerId;
  if (!providerId) return { status: 'not_exposed' };
  const provider = await providerForExposure(providerId);
  const pathPrefix =
    recorded?.path_prefix ?? normalizeIngressPathPrefix(surface.ingress?.path_prefix);
  await provider.down({
    surfaceId: surface.id,
    pathPrefix,
    ...(recorded ? { exposure: recorded } : {}),
  });
  delete state.exposures[surface.id];
  savePublicIngressState(state, deps);
  auditChain.record({
    agentId,
    action: 'ingress_withdraw',
    operation: 'ingress:withdraw',
    result: 'completed',
    reason: recorded ? 'recorded exposure withdrawn' : 'mapping withdrawn without a state record',
    metadata: {
      surface_id: surface.id,
      provider_id: providerId,
      public_url: recorded?.public_url ?? null,
      path_prefix: pathPrefix,
    },
  });
  return { status: 'withdrawn', ...(recorded ? { exposure: recorded } : {}) };
}

export interface SurfaceIngressStatus {
  surface_id: string;
  recorded?: IngressExposure;
  /** Live provider view; undefined when the mapping is gone or unverifiable. */
  live?: IngressExposure;
  live_check: 'confirmed' | 'missing' | 'error' | 'skipped';
  detail?: string;
}

/** Recorded exposures cross-checked against their provider. */
export async function listSurfaceIngressStatus(
  options: { surfaceId?: string } = {},
  deps: PublicIngressServiceDeps = {}
): Promise<SurfaceIngressStatus[]> {
  const state = loadPublicIngressState(deps);
  const ids = options.surfaceId
    ? [resolveIngressSurface(options.surfaceId, deps).id]
    : Object.keys(state.exposures).sort();
  const results: SurfaceIngressStatus[] = [];
  for (const id of ids) {
    const recorded = state.exposures[id];
    if (!recorded) {
      results.push({ surface_id: id, live_check: 'skipped', detail: 'no recorded exposure' });
      continue;
    }
    try {
      const provider = await providerForExposure(recorded.provider_id);
      const live = await provider.status({
        surfaceId: id,
        pathPrefix: recorded.path_prefix,
        exposure: recorded,
      });
      results.push({
        surface_id: id,
        recorded,
        ...(live ? { live } : {}),
        live_check: live ? 'confirmed' : 'missing',
      });
    } catch (error) {
      results.push({
        surface_id: id,
        recorded,
        live_check: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
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
