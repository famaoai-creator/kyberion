import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { createLogger } from '@agent/core/logger';
import { safeExistsSync, safeSpawn } from '@agent/core/secure-io';
import { resolveRustxngBin } from '@agent/core/tool/tool-binary-resolvers';

export const RUSTXNG_PROVIDER_ID = 'rustxng';
export const DEFAULT_RUSTXNG_BASE_URL = 'http://127.0.0.1:8888';
const SEARCH_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 2_000;
const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_POLL_MS = 150;
const DEFAULT_IDLE_TIMEOUT_SEC = 300;

const logger = createLogger('search-rustxng');

export type RustxngSearchHit = {
  title: string;
  url: string;
  content: string;
  raw_content?: string;
  engine?: string;
  score?: number;
};

export type RustxngSearchResponse = {
  provider: typeof RUSTXNG_PROVIDER_ID;
  query: string;
  top_k: number;
  base_url: string;
  results: RustxngSearchHit[];
  unresponsive_engines: Array<[string, string]>;
  /** True when this call auto-started a loopback sidecar. */
  sidecar_started?: boolean;
};

export type RustxngRuntimeDeps = {
  probeHealth?: (baseUrl: string) => Promise<boolean>;
  resolveBin?: () => string;
  spawn?: typeof safeSpawn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  existsSync?: (path: string) => boolean;
};

let sidecarStartInFlight: Promise<boolean> | null = null;

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

/** Base URL: KYBERION_RUSTXNG_URL → default http://127.0.0.1:8888. */
export function resolveRustxngBaseUrl(override?: string): string {
  const fromEnv = getRegisteredEnvText('KYBERION_RUSTXNG_URL')?.trim();
  const raw = (override?.trim() || fromEnv || DEFAULT_RUSTXNG_BASE_URL).trim();
  return stripTrailingSlashes(raw);
}

function assertHttpBaseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`search-actuator: rustxng base URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`search-actuator: rustxng base URL must be http(s): ${raw}`);
  }
  return parsed;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function autostartEnabled(): boolean {
  const raw = getRegisteredEnvText('KYBERION_RUSTXNG_AUTOSTART')?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

function idleTimeoutSeconds(): number {
  const raw = getRegisteredEnvText('KYBERION_RUSTXNG_IDLE_TIMEOUT')?.trim();
  if (!raw) return DEFAULT_IDLE_TIMEOUT_SEC;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IDLE_TIMEOUT_SEC;
  return Math.floor(value);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeRustxngHealth(baseUrl = resolveRustxngBaseUrl()): Promise<boolean> {
  const origin = assertHttpBaseUrl(baseUrl);
  try {
    const response = await fetchWithTimeout(
      new URL('/healthz', origin).toString(),
      HEALTH_TIMEOUT_MS
    );
    return response.ok;
  } catch {
    return false;
  }
}

function installHint(bin: string): string {
  return (
    `Binary: ${bin} — install with \`pnpm tool:setup -- --tool rustxng --apply\`, ` +
    `or set KYBERION_RUSTXNG_BIN / KYBERION_RUSTXNG_URL`
  );
}

/**
 * If the local RustXNG HTTP API is down on a loopback URL, spawn a detached
 * sidecar (managed binary) with RUSTXNG_IDLE_TIMEOUT so idle instances exit.
 * Remote URLs never auto-start. Returns whether this call started a sidecar.
 */
export async function ensureRustxngReachable(
  baseUrl = resolveRustxngBaseUrl(),
  deps: RustxngRuntimeDeps = {}
): Promise<boolean> {
  const probe = deps.probeHealth ?? probeRustxngHealth;
  if (await probe(baseUrl)) return false;

  const origin = assertHttpBaseUrl(baseUrl);
  if (!isLoopbackHost(origin.hostname)) {
    throw new Error(
      `search-actuator: rustxng is not reachable at ${baseUrl}/healthz ` +
        `(auto-start only supports loopback hosts; start the service or set KYBERION_RUSTXNG_URL)`
    );
  }
  if (!autostartEnabled()) {
    throw new Error(
      `search-actuator: rustxng is not reachable at ${baseUrl}/healthz ` +
        `(KYBERION_RUSTXNG_AUTOSTART is disabled — start rustxng manually)`
    );
  }

  if (!sidecarStartInFlight) {
    sidecarStartInFlight = startLoopbackSidecar(origin, deps).finally(() => {
      sidecarStartInFlight = null;
    });
  }
  await sidecarStartInFlight;

  if (!(await probe(baseUrl))) {
    const bin = (deps.resolveBin ?? resolveRustxngBin)();
    throw new Error(
      `search-actuator: rustxng sidecar started but ${baseUrl}/healthz stayed down. ${installHint(bin)}`
    );
  }
  return true;
}

async function startLoopbackSidecar(origin: URL, deps: RustxngRuntimeDeps): Promise<boolean> {
  const resolveBin = deps.resolveBin ?? resolveRustxngBin;
  const spawn = deps.spawn ?? safeSpawn;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const existsSync = deps.existsSync ?? ((candidate: string) => safeExistsSync(candidate));

  const bin = resolveBin();
  if (bin.includes('/') || bin.includes('\\')) {
    if (!existsSync(bin)) {
      throw new Error(`search-actuator: rustxng binary missing at ${bin}. ${installHint(bin)}`);
    }
  }

  const bindHost =
    origin.hostname === 'localhost' || origin.hostname === '[::1]'
      ? '127.0.0.1'
      : origin.hostname.replace(/^\[|\]$/g, '');
  const port = origin.port || '8888';
  const idleSec = idleTimeoutSeconds();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUSTXNG_IDLE_TIMEOUT: String(idleSec),
  };

  logger.info(
    `starting rustxng sidecar ${bin} --bind ${bindHost} --port ${port} (idle=${idleSec}s)`
  );
  try {
    const child = spawn(bin, ['--bind', bindHost, '--port', port], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
  } catch (error: unknown) {
    throw new Error(
      `search-actuator: failed to spawn rustxng (${error instanceof Error ? error.message : String(error)}). ${installHint(bin)}`
    );
  }

  const deadline = now() + STARTUP_TIMEOUT_MS;
  const probe = deps.probeHealth ?? probeRustxngHealth;
  const baseUrl = stripTrailingSlashes(origin.origin);
  while (now() < deadline) {
    if (await probe(baseUrl)) return true;
    await sleep(STARTUP_POLL_MS);
  }
  return false;
}

/** Test-only: clear the in-flight sidecar start latch. */
export function _resetRustxngSidecarLatchForTests(): void {
  sidecarStartInFlight = null;
}

function asHit(value: unknown): RustxngSearchHit | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const url = typeof row.url === 'string' ? row.url.trim() : '';
  if (!url) return null;
  const title = typeof row.title === 'string' ? row.title : '';
  const content = typeof row.content === 'string' ? row.content : '';
  const hit: RustxngSearchHit = { title, url, content };
  if (typeof row.raw_content === 'string' && row.raw_content.length > 0) {
    hit.raw_content = row.raw_content;
  }
  if (typeof row.engine === 'string' && row.engine.length > 0) {
    hit.engine = row.engine;
  }
  if (typeof row.score === 'number' && Number.isFinite(row.score)) {
    hit.score = row.score;
  }
  return hit;
}

function parseUnresponsive(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  const out: Array<[string, string]> = [];
  for (const entry of value) {
    if (Array.isArray(entry) && entry.length >= 2) {
      out.push([String(entry[0] ?? ''), String(entry[1] ?? '')]);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const row = entry as Record<string, unknown>;
      const engine = typeof row.engine === 'string' ? row.engine : '';
      const reason = typeof row.error === 'string' ? row.error : String(row.reason ?? '');
      if (engine) out.push([engine, reason]);
    }
  }
  return out;
}

/**
 * Call RustXNG's SearXNG-compatible JSON search API.
 * Always requests include_raw_content for agent grounding.
 * On loopback, auto-starts a detached sidecar when /healthz is down.
 */
export async function rustxngWebSearch(
  params: {
    query: string;
    top_k: number;
    base_url?: string;
    include_raw_content?: boolean;
  },
  deps: RustxngRuntimeDeps = {}
): Promise<RustxngSearchResponse> {
  const query = params.query.trim();
  if (!query) {
    throw new Error('search-actuator: rustxng requires a non-empty query');
  }
  const top_k = Math.max(1, Math.min(50, params.top_k));
  const base_url = resolveRustxngBaseUrl(params.base_url);
  const origin = assertHttpBaseUrl(base_url);
  const sidecar_started = await ensureRustxngReachable(base_url, deps);

  const searchUrl = new URL('/search', origin);
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('format', 'json');
  searchUrl.searchParams.set('max_results', String(top_k));
  if (params.include_raw_content !== false) {
    searchUrl.searchParams.set('include_raw_content', '1');
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(searchUrl.toString(), SEARCH_TIMEOUT_MS);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `search-actuator: rustxng search timed out after ${SEARCH_TIMEOUT_MS}ms (${base_url})`
      );
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(
      `search-actuator: rustxng search failed with status ${response.status} (${searchUrl.toString()})`
    );
  }

  const body = (await response.json()) as Record<string, unknown>;
  const rawResults = Array.isArray(body.results) ? body.results : [];
  const results: RustxngSearchHit[] = [];
  for (const row of rawResults) {
    const hit = asHit(row);
    if (hit) results.push(hit);
    if (results.length >= top_k) break;
  }

  return {
    provider: RUSTXNG_PROVIDER_ID,
    query,
    top_k,
    base_url,
    results,
    unresponsive_engines: parseUnresponsive(body.unresponsive_engines),
    ...(sidecar_started ? { sidecar_started: true } : {}),
  };
}
