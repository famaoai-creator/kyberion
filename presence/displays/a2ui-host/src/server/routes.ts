/**
 * Host routes — static viewer, provider catalog, and the provider proxy.
 *
 * The proxy is the only way the viewer reaches a producer. It forwards
 * GET/POST to `<provider base>/api/...` with the query string, a JSON body
 * and the tenant hint header, and hands the JSON answer back with the
 * upstream status. Anything else (other providers, non-`/api/` paths, other
 * methods, non-JSON answers) is refused with a plain error envelope.
 */
import type express from 'express';
import expressModule from 'express';
import { rateLimit } from 'express-rate-limit';
import * as path from 'node:path';
import type { FetchLike } from '../framework/actions.js';
import { findProvider, type A2UIProvider } from './providers.js';

export interface A2UIHostRouteOptions {
  providers: readonly A2UIProvider[];
  staticDir: string;
  /** Directory holding the compiled browser modules (served under `/js`). */
  jsDir: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export const TENANT_HEADER = 'x-kyberion-tenant';
export const PROXY_PATH_PATTERN = /^\/api\/[A-Za-z0-9/_\-.?=&%:]*$/u;
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

interface UpstreamResult {
  status: number;
  body: unknown;
  jsonOk: boolean;
}

function errorEnvelope(status: number, error: string) {
  return { ok: false, status, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tenantHint(req: express.Request): string | undefined {
  const header = req.header(TENANT_HEADER);
  if (typeof header === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(header)) return header;
  return undefined;
}

async function callUpstream(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    try {
      const body = await response.json();
      return { status: response.status, body, jsonOk: true };
    } catch {
      return { status: response.status, body: null, jsonOk: false };
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return { status: aborted ? 504 : 502, body: null, jsonOk: false };
  } finally {
    clearTimeout(timer);
  }
}

export function securityHeaders(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

/** The shell page is read from disk per request; bound it like other surface pages. */
const shellPageRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json(errorEnvelope(429, 'rate limit exceeded'));
  },
});

export function registerA2UIHostRoutes(app: express.Express, options: A2UIHostRouteOptions): void {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const log = options.log ?? (() => {});

  app.use(securityHeaders);
  app.use(expressModule.json({ limit: '256kb' }));

  app.get('/api/healthz', (_req, res) => {
    res.json({ ok: true, surface: 'a2ui-host', providers: options.providers.length });
  });

  app.get('/api/providers', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      providers: options.providers.map((provider) => ({
        id: provider.id,
        base_url: provider.baseUrl,
      })),
    });
  });

  // Catalog: what a provider can show. Resources come from the headless
  // manifest every surface publishes; components are an optional extra
  // (presence-studio's component registry) and are simply absent elsewhere.
  app.get('/api/providers/:id/catalog', async (req, res) => {
    const provider = findProvider(options.providers, req.params.id);
    if (!provider) {
      res.status(404).json(errorEnvelope(404, 'unknown provider'));
      return;
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    const tenant = tenantHint(req);
    if (tenant) headers[TENANT_HEADER] = tenant;
    const locale =
      typeof req.query.locale === 'string' && /^(ja|en)$/u.test(req.query.locale)
        ? req.query.locale
        : null;
    const params = new URLSearchParams();
    if (tenant) params.set('tenant', tenant);
    if (locale) params.set('locale', locale);
    const query = params.size ? `?${params.toString()}` : '';
    const [manifest, components] = await Promise.all([
      callUpstream(
        fetchImpl,
        `${provider.baseUrl}/api/headless/manifest${query}`,
        { method: 'GET', headers },
        timeoutMs
      ),
      callUpstream(
        fetchImpl,
        `${provider.baseUrl}/api/components${query}`,
        { method: 'GET', headers },
        timeoutMs
      ),
    ]);
    if (!manifest.jsonOk || manifest.status >= 400) {
      res.status(502).json(errorEnvelope(502, 'provider manifest unavailable'));
      return;
    }
    const manifestBody = isRecord(manifest.body) ? manifest.body : {};
    const manifestData = isRecord(manifestBody.manifest) ? manifestBody.manifest : manifestBody;
    const resources = (Array.isArray(manifestData.resources) ? manifestData.resources : [])
      .filter(
        (resource): resource is Record<string, unknown> =>
          isRecord(resource) && typeof resource.a2ui_path === 'string'
      )
      .map((resource) => ({
        resource: String(resource.resource ?? ''),
        description: typeof resource.description === 'string' ? resource.description : '',
        a2ui_path: String(resource.a2ui_path),
      }))
      .filter((resource) => PROXY_PATH_PATTERN.test(resource.a2ui_path));
    // Operations flagged `a2ui_projection` are readable as surfaces too
    // (snapshot producers such as computer-surface publish only these).
    // Event streams are excluded: they never answer with one JSON body.
    const known = new Set(resources.map((resource) => resource.a2ui_path));
    // A resource that already has a projection also has a plain query path;
    // the operation for that query path is the non-A2UI variant, so skip it.
    // A resource without a projection (snapshot producers) is reached
    // through its query operation instead, and keeps the resource's name.
    const allResources = (
      Array.isArray(manifestData.resources) ? manifestData.resources : []
    ).filter(isRecord);
    const projectedQueryPaths = new Set(
      allResources
        .filter((resource) => typeof resource.a2ui_path === 'string')
        .map((resource) => String(resource.query_path ?? ''))
    );
    const byQueryPath = new Map(
      allResources
        .filter((resource) => typeof resource.query_path === 'string')
        .map((resource) => [String(resource.query_path), resource] as const)
    );
    for (const operation of Array.isArray(manifestData.operations) ? manifestData.operations : []) {
      if (
        !isRecord(operation) ||
        operation.a2ui_projection !== true ||
        operation.method !== 'GET'
      ) {
        continue;
      }
      const opPath = typeof operation.path === 'string' ? operation.path : '';
      if (
        !PROXY_PATH_PATTERN.test(opPath) ||
        known.has(opPath) ||
        projectedQueryPaths.has(opPath) ||
        /stream/iu.test(opPath)
      ) {
        continue;
      }
      known.add(opPath);
      const owner = byQueryPath.get(opPath);
      const description = typeof operation.description === 'string' ? operation.description : '';
      resources.push({
        resource: String(owner?.resource ?? operation.resource ?? operation.operation_id ?? opPath),
        description: typeof owner?.description === 'string' ? owner.description : description,
        a2ui_path: opPath,
      });
    }
    const componentBody =
      components.jsonOk && components.status < 400 && isRecord(components.body)
        ? components.body
        : {};
    const componentList = (Array.isArray(componentBody.components) ? componentBody.components : [])
      .filter(
        (component): component is Record<string, unknown> =>
          isRecord(component) && typeof component.a2ui_path === 'string'
      )
      .map((component) => ({
        id: String(component.id ?? ''),
        title: typeof component.title === 'string' ? component.title : String(component.id ?? ''),
        summary: typeof component.summary === 'string' ? component.summary : '',
        a2ui_path: String(component.a2ui_path),
      }))
      .filter((component) => PROXY_PATH_PATTERN.test(component.a2ui_path));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      provider: provider.id,
      surface: typeof manifestData.surface === 'string' ? manifestData.surface : provider.id,
      resources,
      components: componentList,
    });
  });

  // Proxy: `/api/providers/:id/proxy/api/...` → `<base>/api/...` (same query).
  app.use('/api/providers/:id/proxy', async (req, res) => {
    const provider = findProvider(options.providers, req.params.id);
    if (!provider) {
      res.status(404).json(errorEnvelope(404, 'unknown provider'));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).json(errorEnvelope(405, 'method not allowed'));
      return;
    }
    const target = req.url.startsWith('/') ? req.url : `/${req.url}`;
    if (!PROXY_PATH_PATTERN.test(target) || target.includes('..')) {
      res.status(400).json(errorEnvelope(400, 'only provider /api/ paths can be proxied'));
      return;
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    const tenant = tenantHint(req);
    if (tenant) headers[TENANT_HEADER] = tenant;
    const init: RequestInit = { method: req.method, headers };
    if (req.method === 'POST') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(isRecord(req.body) ? req.body : {});
    }
    const upstream = await callUpstream(fetchImpl, `${provider.baseUrl}${target}`, init, timeoutMs);
    res.setHeader('Cache-Control', 'no-store');
    if (!upstream.jsonOk) {
      log(
        `[a2ui-host] upstream ${provider.id} ${req.method} ${target} → ${upstream.status} (non-json)`
      );
      res
        .status(upstream.status >= 500 ? upstream.status : 502)
        .json(errorEnvelope(502, 'provider returned no json'));
      return;
    }
    res.status(upstream.status).json(upstream.body);
  });

  app.get('/', shellPageRateLimiter, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(options.staticDir, 'index.html'));
  });
  app.use('/js', expressModule.static(options.jsDir, { index: false, fallthrough: true }));
  app.use(expressModule.static(options.staticDir, { index: false }));
}
