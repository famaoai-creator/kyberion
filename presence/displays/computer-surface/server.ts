import express from 'express';
import { createServer } from 'node:http';
import * as path from 'node:path';
import {
  assertSurfaceOperation,
  SurfaceAuthorizationError,
  type SurfaceAuthorizationContext,
} from '@agent/core/surface-authorization';
import {
  buildComputerSurfaceManifest,
  filterHeadlessManifestForViewer,
} from '@agent/core/headless-surface-contract';
import { validateA2UIMessage, type A2UIMessage } from '@agent/core/a2ui';
import { parseIntentResolutionContract } from '@agent/core/intent-resolution-contract';
import {
  loadPersonalAgentIdentityAtPath,
  loadPersonalIdentityAtPath,
  parsePersonalAgentIdentity,
  parsePersonalSovereignIdentity,
} from '@agent/core/personal-identity-reader';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
} from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import {
  assertComputerSurfacePayloadInScope,
  computerSurfaceServerTenantResource,
  ComputerSurfaceViewerError,
  resolveComputerSurfaceViewerContext,
} from './auth.js';
import {
  getComputerSurfaceAccess,
  getComputerSurfaceGuardedSurfaceUrl,
  getComputerSurfaceOsSnapshot,
  getComputerSurfaceTenantScope,
  recordComputerSurfaceRead,
} from './os-control-plane.js';

type Client = express.Response;

interface SurfaceSnapshot {
  catalogId?: string;
  title?: string;
  components: Array<{ id: string; type: string; props?: Record<string, unknown> }>;
  data: Record<string, unknown>;
}

/**
 * Normalize the optional display-only intent contract at the A2UI boundary.
 * It is never used for authorization or execution decisions.
 */
export function projectComputerSurfaceData(data: Record<string, unknown>): Record<string, unknown> {
  const projected = { ...data };
  const candidate = projected.intentResolution ?? projected.intent_resolution;
  delete projected.intentResolution;
  delete projected.intent_resolution;
  if (candidate === undefined) return projected;
  const contract = parseIntentResolutionContract(candidate);
  if (contract) projected.intentResolution = contract;
  return projected;
}

export const app: express.Express = express();
export const server = createServer(app);
const staticDir = path.join(pathResolver.rootDir(), 'presence/displays/computer-surface/static');
const PORT = Number(getRegisteredEnvText('COMPUTER_SURFACE_PORT') || 3040);
const HOST = getRegisteredEnvText('COMPUTER_SURFACE_HOST') || '127.0.0.1';
const sseClients = new Set<Client>();
const computerSurfaceManifest = buildComputerSurfaceManifest();

export function resolveExistingIdentityFile(filePath: string): string | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    return safeExistsSync(safePath) && safeLstat(safePath).isFile() ? safePath : null;
  } catch {
    return null;
  }
}

function authorizeSurface(
  req: express.Request,
  res: express.Response,
  operationId: string,
  resource?: { tenantSlug?: string; tier?: string }
): SurfaceAuthorizationContext | null {
  let context: SurfaceAuthorizationContext;
  try {
    context = resolveComputerSurfaceViewerContext(req);
  } catch (error) {
    const status = error instanceof ComputerSurfaceViewerError ? error.status : 403;
    res
      .status(status)
      .json({ ok: false, error: error instanceof Error ? error.message : 'Unauthorized.' });
    return null;
  }

  const operation = computerSurfaceManifest.operations.find(
    (candidate) => candidate.operation_id === operationId
  );
  if (!operation) {
    res
      .status(403)
      .json({ ok: false, error: `unknown Computer Surface operation: ${operationId}` });
    return null;
  }

  try {
    assertSurfaceOperation({
      context,
      operation: {
        operationId: operation.operation_id,
        effect: operation.effect,
        requiredRole: operation.required_role,
        requiredPermissions: operation.required_permissions,
      },
      resource: { ...computerSurfaceServerTenantResource(context), ...resource },
    });
    return context;
  } catch (error) {
    const message =
      error instanceof SurfaceAuthorizationError
        ? error.decision.reason
        : error instanceof Error
          ? error.message
          : 'Forbidden.';
    res.status(403).json({ ok: false, error: message });
    return null;
  }
}

const state: {
  surfaces: Record<string, SurfaceSnapshot>;
  lastUpdatedAt: string | null;
} = {
  surfaces: {
    'computer-surface': {
      catalogId: 'computer-surface',
      title: 'Computer Surface',
      components: [],
      data: {
        sessionId: '',
        executor: '',
        status: 'idle',
        latestAction: '',
        target: '',
        detail: '',
        screenshotPath: '',
        actionCount: 0,
        updatedAt: null,
      },
    },
  },
  lastUpdatedAt: null,
};

function applyA2UIMessage(message: A2UIMessage): void {
  if (message.createSurface) {
    const current = state.surfaces[message.createSurface.surfaceId] || { components: [], data: {} };
    state.surfaces[message.createSurface.surfaceId] = {
      ...current,
      catalogId: message.createSurface.catalogId,
      title: message.createSurface.title || current.title,
      components: current.components || [],
      data: current.data || {},
    };
  }

  if (message.updateComponents) {
    const current = state.surfaces[message.updateComponents.surfaceId] || {
      components: [],
      data: {},
    };
    state.surfaces[message.updateComponents.surfaceId] = {
      ...current,
      components: message.updateComponents.components || [],
    };
  }

  if (message.updateDataModel) {
    const current = state.surfaces[message.updateDataModel.surfaceId] || {
      components: [],
      data: {},
    };
    state.surfaces[message.updateDataModel.surfaceId] = {
      ...current,
      data: {
        ...(current.data || {}),
        ...projectComputerSurfaceData(message.updateDataModel.data || {}),
      },
    };
  }

  if (message.deleteSurface) {
    delete state.surfaces[message.deleteSurface.surfaceId];
  }

  state.lastUpdatedAt = nowIso();
}

function emitState(): void {
  const chunk = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const client of sseClients) client.write(chunk);
}

if (!safeExistsSync(staticDir)) {
  safeMkdir(staticDir, { recursive: true });
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(staticDir));

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

app.get('/api/headless/manifest', (req, res) => {
  const context = authorizeSurface(req, res, 'computer_surface.manifest.read');
  if (!context) return;
  res.json(filterHeadlessManifestForViewer(context, computerSurfaceManifest));
});

app.get('/api/identity', (req, res) => {
  if (
    !authorizeSurface(req, res, 'computer_surface.identity.read', {
      tier: 'personal',
    })
  )
    return;
  try {
    const personalDir = pathResolver.knowledge('personal');
    const result = withExecutionContext('ecosystem_architect', () => {
      const idPath = path.join(personalDir, 'my-identity.json');
      const agentPath = path.join(personalDir, 'agent-identity.json');
      const visionPath = path.join(personalDir, 'my-vision.md');
      const safeIdPath = resolveExistingIdentityFile(idPath);
      const safeAgentPath = resolveExistingIdentityFile(agentPath);
      const safeVisionPath = resolveExistingIdentityFile(visionPath);
      const sovereign = safeIdPath
        ? parsePersonalSovereignIdentity(loadPersonalIdentityAtPath(safeIdPath))
        : null;
      const agent = safeAgentPath
        ? parsePersonalAgentIdentity(loadPersonalAgentIdentityAtPath(safeAgentPath))
        : null;
      const visionRaw = safeVisionPath
        ? (safeReadFile(safeVisionPath, { encoding: 'utf8' }) as string)
        : null;
      const vision = visionRaw
        ? visionRaw
            .replace(/^#[^\n]*\n+/, '')
            .trim()
            .slice(0, 600)
        : null;
      return { sovereign, agent, vision };
    });
    res.json({
      ok: true,
      onboarded: Boolean(result.sovereign && result.agent),
      sovereign: result.sovereign,
      agent: result.agent,
      vision: result.vision,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    surfaces: Object.keys(state.surfaces).length,
    timestamp: nowIso(),
  });
});

app.get('/api/state', (req, res) => {
  if (!authorizeSurface(req, res, 'computer_surface.state.read')) return;
  res.json(state);
});

app.get('/api/os/control-plane', (req, res) => {
  if (!authorizeSurface(req, res, 'computer_surface.os_control_plane.read')) return;
  const rawMissionId = req.query.mission_id;
  if (Array.isArray(rawMissionId)) {
    res.status(400).json({ ok: false, error: 'mission_id must be a single value' });
    return;
  }
  try {
    const access = getComputerSurfaceAccess();
    const snapshot = getComputerSurfaceOsSnapshot(
      typeof rawMissionId === 'string' ? rawMissionId : undefined,
      undefined,
      access
    );
    recordComputerSurfaceRead(access, snapshot);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      tenantScope: getComputerSurfaceTenantScope(),
      guardedSurfaceUrl: getComputerSurfaceGuardedSurfaceUrl(),
      ...snapshot,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message.startsWith('[POLICY_VIOLATION]')
        ? error.message
        : 'Unable to load the OS control-plane projection.';
    res.status(message.startsWith('[POLICY_VIOLATION]') ? 403 : 400).json({
      ok: false,
      error: message,
    });
  }
});

app.get('/api/stream', (req, res) => {
  if (!authorizeSurface(req, res, 'computer_surface.stream.read')) return;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  sseClients.add(res);
  res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.post('/a2ui/dispatch', (req, res) => {
  const context = authorizeSurface(req, res, 'computer_surface.a2ui.dispatch');
  if (!context) return;
  const body = req.body;
  try {
    assertComputerSurfacePayloadInScope(context, body);
  } catch (error) {
    const status = error instanceof ComputerSurfaceViewerError ? error.status : 403;
    res
      .status(status)
      .json({ ok: false, error: error instanceof Error ? error.message : 'Forbidden.' });
    return;
  }
  const messages = Array.isArray(body) ? body : [body];
  try {
    for (const message of messages) applyA2UIMessage(validateA2UIMessage(message));
  } catch (error) {
    res
      .status(400)
      .json({ ok: false, error: error instanceof Error ? error.message : 'Invalid A2UI message.' });
    return;
  }
  emitState();
  res.json({ ok: true, applied: messages.length });
});

if (getRegisteredEnvText('NODE_ENV') !== 'test' && getRegisteredEnvText('VITEST') !== 'true') {
  server.listen(PORT, HOST, () => {
    console.log(`[computer-surface] listening on http://${HOST}:${PORT}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    const reason = error?.message || String(error);
    console.error(`[computer-surface] failed to listen on http://${HOST}:${PORT}: ${reason}`);
    process.exitCode = 1;
  });
}
