import express from 'express';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import {
  pathResolver,
  loadJson,
  extractSurfaceBearerToken,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  withExecutionContext,
  type A2UIMessage,
} from '@agent/core';
import { getRegisteredEnvText } from '@agent/core/foundation';
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

export const app: express.Express = express();
export const server = createServer(app);
const staticDir = path.join(pathResolver.rootDir(), 'presence/displays/computer-surface/static');
const PORT = Number(process.env.COMPUTER_SURFACE_PORT || 3040);
const HOST = process.env.COMPUTER_SURFACE_HOST || '127.0.0.1';
const sseClients = new Set<Client>();

function tokenMatches(candidate: string, configured: string | undefined): boolean {
  if (!candidate || !configured) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(configured);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isLoopback(req: express.Request): boolean {
  const remote = req.socket.remoteAddress || '';
  const forwarded = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim();
  const loopbackAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  return (
    loopbackAddresses.includes(remote) && (!forwarded || loopbackAddresses.includes(forwarded))
  );
}

function authorizeSurface(req: express.Request, res: express.Response): boolean {
  const token = extractSurfaceBearerToken(req.headers.authorization);
  const configured =
    getRegisteredEnvText('KYBERION_LOCALADMIN_TOKEN') || getRegisteredEnvText('KYBERION_API_TOKEN');
  if (
    tokenMatches(token, configured) ||
    (isLoopback(req) && getRegisteredEnvText('KYBERION_LOCALHOST_AUTOADMIN') !== 'false')
  ) {
    return true;
  }
  res.status(401).json({ ok: false, error: 'Unauthorized.' });
  return false;
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
        ...(message.updateDataModel.data || {}),
      },
    };
  }

  if (message.deleteSurface) {
    delete state.surfaces[message.deleteSurface.surfaceId];
  }

  state.lastUpdatedAt = new Date().toISOString();
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

app.get('/api/identity', (req, res) => {
  if (!authorizeSurface(req, res)) return;
  try {
    const personalDir = pathResolver.knowledge('personal');
    const result = withExecutionContext('ecosystem_architect', () => {
      const idPath = path.join(personalDir, 'my-identity.json');
      const agentPath = path.join(personalDir, 'agent-identity.json');
      const visionPath = path.join(personalDir, 'my-vision.md');
      const sovereign = safeExistsSync(idPath) ? loadJson<unknown>(idPath) : null;
      const agent = safeExistsSync(agentPath) ? loadJson<unknown>(agentPath) : null;
      const visionRaw = safeExistsSync(visionPath)
        ? (safeReadFile(visionPath, { encoding: 'utf8' }) as string)
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
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/state', (req, res) => {
  if (!authorizeSurface(req, res)) return;
  res.json(state);
});

app.get('/api/os/control-plane', (req, res) => {
  if (!authorizeSurface(req, res)) return;
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
  if (!authorizeSurface(req, res)) return;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  sseClients.add(res);
  res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.post('/a2ui/dispatch', (req, res) => {
  if (!authorizeSurface(req, res)) return;
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) applyA2UIMessage(message as A2UIMessage);
  emitState();
  res.json({ ok: true, applied: messages.length });
});

if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  server.listen(PORT, HOST, () => {
    console.log(`[computer-surface] listening on http://${HOST}:${PORT}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    const reason = error?.message || String(error);
    console.error(`[computer-surface] failed to listen on http://${HOST}:${PORT}: ${reason}`);
    process.exitCode = 1;
  });
}
