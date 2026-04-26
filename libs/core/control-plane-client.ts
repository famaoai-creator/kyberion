import { validateNextActionContract } from './next-action-contract.js';

export type ControlPlaneSurface = 'presence' | 'chronos';

export interface ControlPlaneListResponse<T> {
  ok?: boolean;
  items?: T[];
}

export interface ControlPlaneProjectRecord {
  project_id: string;
  name?: string;
  status?: string;
  tier?: string;
  primary_locale?: string;
  active_missions?: string[];
  service_bindings?: string[];
}

export interface ControlPlaneApprovalRecord {
  id: string;
  title?: string;
  status?: string;
  expected_outcome?: string;
  storageChannel?: string;
  channel?: string;
}

export interface ControlPlaneMissionSeedRecord {
  seed_id: string;
  title?: string;
  status?: string;
  project_id?: string;
  track_id?: string;
  track_name?: string;
  specialist_id?: string;
  mission_type_hint?: string;
  promoted_mission_id?: string;
  metadata?: {
    template_ref?: string;
    skeleton_path?: string;
  };
}

export interface ControlPlaneProjectTrackRecord {
  track_id: string;
  project_id?: string;
  name?: string;
  summary?: string;
  status?: string;
  track_type?: string;
  lifecycle_model?: string;
  gate_readiness?: {
    ready_gate_count?: number;
    total_gate_count?: number;
    current_gate_id?: string;
    current_phase?: string;
    ready?: boolean;
    next_required_artifacts?: Array<{
      artifact_id?: string;
      template_ref?: string;
    }>;
  };
}

export interface ControlPlaneOutcomeRecord {
  artifact_id: string;
  kind?: string;
  preview_text?: string;
  project_id?: string;
  storage_class?: string;
  promoted_refs?: string[];
}

export interface ControlPlaneTaskSessionRecord {
  session_id: string;
  status?: string;
  task_type?: string;
  goal?: { summary?: string };
  project_context?: { project_id?: string };
  artifact?: { preview_text?: string };
}

export interface ChronosOverviewRecord {
  accessRole?: string;
  projects?: ControlPlaneProjectRecord[];
  projectTracks?: ControlPlaneProjectTrackRecord[];
  gateReadiness?: Array<ControlPlaneProjectTrackRecord["gate_readiness"] & { track_id: string }>;
  missionSeeds?: ControlPlaneMissionSeedRecord[];
  pendingApprovals?: Array<Record<string, unknown>>;
  distillCandidates?: Array<Record<string, unknown>>;
  memoryCandidates?: Array<Record<string, unknown>>;
  nextActions?: Array<{
    action_id: string;
    next_action_type: 'request_clarification' | 'approve' | 'inspect_evidence' | 'retry_delivery' | 'promote_mission_seed' | 'resume_mission';
    reason: string;
    risk: 'low' | 'medium' | 'high';
    suggested_command?: string;
    suggested_surface_action?: 'approvals' | 'mission-seeds' | 'memory-promotion-queue' | 'next-actions';
    approval_required: boolean;
  }>;
}

export interface ControlPlaneErrorOptions {
  surface: ControlPlaneSurface;
  pathname: string;
  suggestedCommand?: string;
}

export class ControlPlaneClientError extends Error {
  surface: ControlPlaneSurface;
  pathname: string;
  suggestedCommand?: string;

  constructor(message: string, options: ControlPlaneErrorOptions) {
    super(message);
    this.name = 'ControlPlaneClientError';
    this.surface = options.surface;
    this.pathname = options.pathname;
    this.suggestedCommand = options.suggestedCommand;
  }
}

export interface ControlPlaneClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  retryCount?: number;
}

export interface ControlPlaneRemediationPlan {
  surface: ControlPlaneSurface;
  runtimeId: string;
  suggestedCommand: string;
}

const DEFAULT_BASE_URLS: Record<ControlPlaneSurface, string> = {
  presence: String(process.env.PRESENCE_STUDIO_URL || 'http://127.0.0.1:3031').replace(/\/$/, ''),
  chronos: String(process.env.CHRONOS_URL || 'http://127.0.0.1:3000').replace(/\/$/, ''),
};

const DEFAULT_REMEDIATION_PLANS: Record<ControlPlaneSurface, ControlPlaneRemediationPlan> = {
  presence: {
    surface: 'presence',
    runtimeId: 'presence-studio',
    suggestedCommand: 'pnpm surfaces:reconcile',
  },
  chronos: {
    surface: 'chronos',
    runtimeId: 'chronos-mirror-v2',
    suggestedCommand: 'pnpm surfaces:reconcile',
  },
};

export function getControlPlaneBaseUrl(surface: ControlPlaneSurface, override?: string): string {
  return String(override || DEFAULT_BASE_URLS[surface]).replace(/\/$/, '');
}

function resolveToken(surface: ControlPlaneSurface, override?: string): string {
  if (override) return override;
  if (surface === 'chronos') {
    return String(process.env.KYBERION_LOCALADMIN_TOKEN || process.env.KYBERION_API_TOKEN || '');
  }
  return '';
}

export function getControlPlaneRemediationPlan(surface: ControlPlaneSurface): ControlPlaneRemediationPlan {
  return DEFAULT_REMEDIATION_PLANS[surface];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferSurfaceMismatchMessage(surface: ControlPlaneSurface, pathname: string, text: string): string | null {
  const normalized = String(text || '');
  const isExpressMismatch = normalized.includes('Cannot GET') && normalized.includes(pathname);
  const isNextNotFound = /404[:\s]/i.test(normalized) && normalized.includes('This page could not be found.');
  if (!isExpressMismatch && !isNextNotFound) {
    return null;
  }
  return `${surface} surface does not expose ${pathname}. This usually means an older process is still serving the port or the surface was not restarted after the latest build.`;
}

function suggestedCommandFor(surface: ControlPlaneSurface): string {
  return getControlPlaneRemediationPlan(surface).suggestedCommand;
}

async function requestControlPlane(
  surface: ControlPlaneSurface,
  pathname: string,
  init?: RequestInit,
  options?: ControlPlaneClientOptions,
): Promise<Response> {
  const token = resolveToken(surface, options?.token);
  const timeoutMs = options?.timeoutMs ?? 5000;
  const retryCount = options?.retryCount ?? 1;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`control-plane request timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const response = await fetch(`${getControlPlaneBaseUrl(surface, options?.baseUrl)}${pathname}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init?.headers || {}),
        },
      });
      clearTimeout(timeout);
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < retryCount) {
        await sleep(150 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`control-plane request failed for ${surface}${pathname}`);
}

export async function requestControlPlaneJson(
  surface: ControlPlaneSurface,
  pathname: string,
  init?: RequestInit,
  options?: ControlPlaneClientOptions,
): Promise<any> {
  const response = await requestControlPlane(surface, pathname, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  }, options);
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { ok: response.ok, raw: text };
  }
  if (!response.ok) {
    const mismatch = inferSurfaceMismatchMessage(surface, pathname, text);
    throw new ControlPlaneClientError(
      mismatch || body?.error || body?.raw || `HTTP ${response.status}`,
      {
        surface,
        pathname,
        suggestedCommand: mismatch ? suggestedCommandFor(surface) : undefined,
      },
    );
  }
  if (body && typeof body === 'object' && typeof body.raw === 'string') {
    const mismatch = inferSurfaceMismatchMessage(surface, pathname, body.raw);
    if (mismatch) {
      throw new ControlPlaneClientError(mismatch, {
        surface,
        pathname,
        suggestedCommand: suggestedCommandFor(surface),
      });
    }
  }
  return body;
}

export async function requestControlPlaneText(
  surface: ControlPlaneSurface,
  pathname: string,
  init?: RequestInit,
  options?: ControlPlaneClientOptions,
): Promise<string> {
  const response = await requestControlPlane(surface, pathname, init, options);
  const text = await response.text();
  if (!response.ok) {
    const mismatch = inferSurfaceMismatchMessage(surface, pathname, text);
    throw new ControlPlaneClientError(mismatch || text || `HTTP ${response.status}`, {
      surface,
      pathname,
      suggestedCommand: mismatch ? suggestedCommandFor(surface) : undefined,
    });
  }
  return text;
}

export function createControlPlaneClient(surface: ControlPlaneSurface, options?: ControlPlaneClientOptions) {
  function sanitizeNextActions(value: unknown): ChronosOverviewRecord['nextActions'] {
    if (!Array.isArray(value)) return [];
    const sanitized = value.filter((candidate) => validateNextActionContract(candidate).valid);
    return sanitized as ChronosOverviewRecord['nextActions'];
  }

  return {
    surface,
    baseUrl: getControlPlaneBaseUrl(surface, options?.baseUrl),
    async getJson<T = any>(pathname: string): Promise<T> {
      return requestControlPlaneJson(surface, pathname, undefined, options) as Promise<T>;
    },
    async postJson<T = any>(pathname: string, payload: unknown): Promise<T> {
      return requestControlPlaneJson(surface, pathname, {
        method: 'POST',
        body: JSON.stringify(payload),
      }, options) as Promise<T>;
    },
    async getText(pathname: string) {
      return requestControlPlaneText(surface, pathname, undefined, options);
    },
    async listProjects(): Promise<ControlPlaneProjectRecord[]> {
      const body = await requestControlPlaneJson(surface, '/api/projects', undefined, options) as ControlPlaneListResponse<ControlPlaneProjectRecord>;
      return Array.isArray(body?.items) ? body.items : [];
    },
    async listApprovals(): Promise<ControlPlaneApprovalRecord[]> {
      const pathname = surface === 'chronos' ? '/api/intelligence' : '/api/approvals';
      const body = await requestControlPlaneJson(surface, pathname, undefined, options) as any;
      if (surface === 'chronos') {
        return Array.isArray(body?.pendingApprovals) ? body.pendingApprovals : [];
      }
      return Array.isArray(body?.items) ? body.items : [];
    },
    async listMissionSeeds(): Promise<ControlPlaneMissionSeedRecord[]> {
      const pathname = surface === 'chronos' ? '/api/intelligence' : '/api/mission-seeds';
      const body = await requestControlPlaneJson(surface, pathname, undefined, options) as any;
      if (surface === 'chronos') {
        return Array.isArray(body?.missionSeeds) ? body.missionSeeds : [];
      }
      return Array.isArray(body?.items) ? body.items : [];
    },
    async listProjectTracks(): Promise<ControlPlaneProjectTrackRecord[]> {
      const pathname = surface === 'chronos' ? '/api/intelligence' : '/api/project-tracks';
      const body = await requestControlPlaneJson(surface, pathname, undefined, options) as any;
      if (surface === 'chronos') {
        const tracks = Array.isArray(body?.projectTracks) ? body.projectTracks : [];
        const readiness = new Map(
          (Array.isArray(body?.gateReadiness) ? body.gateReadiness : []).map((item: any) => [String(item.track_id || ""), item]),
        );
        return tracks.map((track: any) => ({
          ...track,
          gate_readiness: track?.gate_readiness || readiness.get(String(track?.track_id || "")),
        }));
      }
      return Array.isArray(body?.items) ? body.items : [];
    },
    async listOutcomes(): Promise<ControlPlaneOutcomeRecord[]> {
      const body = await requestControlPlaneJson(surface, '/api/outcomes', undefined, options) as ControlPlaneListResponse<ControlPlaneOutcomeRecord>;
      return Array.isArray(body?.items) ? body.items : [];
    },
    async listTaskSessions(): Promise<ControlPlaneTaskSessionRecord[]> {
      const body = await requestControlPlaneJson(surface, '/api/task-sessions', undefined, options) as ControlPlaneListResponse<ControlPlaneTaskSessionRecord>;
      return Array.isArray(body?.items) ? body.items : [];
    },
    async getChronosOverview(): Promise<ChronosOverviewRecord> {
      const body = await requestControlPlaneJson('chronos', '/api/intelligence', undefined, options) as ChronosOverviewRecord;
      return {
        ...body,
        nextActions: sanitizeNextActions(body?.nextActions),
      };
    },
  };
}
