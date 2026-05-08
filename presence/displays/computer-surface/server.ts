import express from 'express';
import { createServer } from 'node:http';
import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  withExecutionContext,
  type A2UIMessage,
} from '@agent/core';

type Client = express.Response;

interface SurfaceSnapshot {
  catalogId?: string;
  title?: string;
  components: Array<{ id: string; type: string; props?: Record<string, unknown> }>;
  data: Record<string, unknown>;
}

const app = express();
const server = createServer(app);
const staticDir = path.join(pathResolver.rootDir(), 'presence/displays/computer-surface/static');
const PORT = Number(process.env.COMPUTER_SURFACE_PORT || 3040);
const HOST = process.env.COMPUTER_SURFACE_HOST || '127.0.0.1';
const sseClients = new Set<Client>();

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
    const current = state.surfaces[message.updateComponents.surfaceId] || { components: [], data: {} };
    state.surfaces[message.updateComponents.surfaceId] = {
      ...current,
      components: message.updateComponents.components || [],
    };
  }

  if (message.updateDataModel) {
    const current = state.surfaces[message.updateDataModel.surfaceId] || { components: [], data: {} };
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

app.get('/api/identity', (_req, res) => {
  try {
    const personalDir = pathResolver.knowledge('personal');
    const result = withExecutionContext('ecosystem_architect', () => {
      const idPath = path.join(personalDir, 'my-identity.json');
      const agentPath = path.join(personalDir, 'agent-identity.json');
      const visionPath = path.join(personalDir, 'my-vision.md');
      const sovereign = safeExistsSync(idPath)
        ? JSON.parse(safeReadFile(idPath, { encoding: 'utf8' }) as string)
        : null;
      const agent = safeExistsSync(agentPath)
        ? JSON.parse(safeReadFile(agentPath, { encoding: 'utf8' }) as string)
        : null;
      const visionRaw = safeExistsSync(visionPath)
        ? (safeReadFile(visionPath, { encoding: 'utf8' }) as string)
        : null;
      const vision = visionRaw
        ? visionRaw.replace(/^#[^\n]*\n+/, '').trim().slice(0, 600)
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

app.get('/api/state', (_req, res) => {
  res.json(state);
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  sseClients.add(res);
  res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.post('/a2ui/dispatch', (req, res) => {
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) applyA2UIMessage(message as A2UIMessage);
  emitState();
  res.json({ ok: true, applied: messages.length });
});

server.listen(PORT, HOST, () => {
  console.log(`[computer-surface] listening on http://${HOST}:${PORT}`);
});
