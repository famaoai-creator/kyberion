import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  buildPresenceSurfaceFrame,
  createPresenceVoiceStimulus,
  logger,
  pathResolver,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  type A2UIMessage,
  type PresenceTimelineAdf,
  validatePresenceTimeline,
} from '@agent/core';

type Client = express.Response;

interface SurfaceSnapshot {
  catalogId?: string;
  title?: string;
  components: Array<{ id: string; type: string; props?: Record<string, unknown> }>;
  data: Record<string, unknown>;
}

interface PresenceStudioState {
  surfaces: Record<string, SurfaceSnapshot>;
  recentStimuli: Array<Record<string, unknown>>;
  lastUpdatedAt: string | null;
}

const app = express();
const server = createServer(app);
const staticDir = path.join(pathResolver.rootDir(), 'presence/displays/presence-studio/static');
const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const PORT = Number(process.env.PRESENCE_STUDIO_PORT || 3031);
const HOST = process.env.PRESENCE_STUDIO_HOST || '127.0.0.1';
const VOICE_HUB_URL = process.env.VOICE_HUB_URL || 'http://127.0.0.1:3032';
const sseClients = new Set<Client>();
const activeTimelineTimers = new Map<string, NodeJS.Timeout[]>();

process.env.MISSION_ROLE ||= 'surface_runtime';

const state: PresenceStudioState = {
  surfaces: {},
  recentStimuli: [],
  lastUpdatedAt: null,
};

function ensureStimuliDir(): void {
  const dir = path.dirname(STIMULI_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

function rememberStimulus(stimulus: Record<string, unknown>): void {
  state.recentStimuli.push(stimulus);
  state.recentStimuli = state.recentStimuli.slice(-20);
  state.lastUpdatedAt = new Date().toISOString();
}

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

function getSurfaceData(surfaceId: string): Record<string, unknown> {
  return state.surfaces[surfaceId]?.data || {};
}

function rebuildPresenceSurface(surfaceId: string): void {
  const data = getSurfaceData(surfaceId);
  const messages = buildPresenceSurfaceFrame({
    surfaceId,
    title: typeof data.title === 'string' ? data.title : 'Presence Studio',
    status: typeof data.status === 'string' ? data.status : 'ready',
    expression: typeof data.expression === 'string' ? data.expression : 'neutral',
    subtitle: typeof data.subtitle === 'string' ? data.subtitle : '',
    transcript: Array.isArray(data.transcript) ? data.transcript as Array<{ speaker: string; text: string }> : [],
  });
  for (const message of messages) applyA2UIMessage(message);
}

function updatePresenceSurface(surfaceId: string, patch: Record<string, unknown>): void {
  const current = getSurfaceData(surfaceId);
  state.surfaces[surfaceId] = {
    ...(state.surfaces[surfaceId] || { components: [], data: {} }),
    data: {
      ...current,
      ...patch,
    },
  };
  rebuildPresenceSurface(surfaceId);
}

function clearTimeline(surfaceId: string): void {
  const timers = activeTimelineTimers.get(surfaceId) || [];
  for (const timer of timers) clearTimeout(timer);
  activeTimelineTimers.delete(surfaceId);
}

function applyTimelineEvent(surfaceId: string, timeline: PresenceTimelineAdf, event: PresenceTimelineAdf['events'][number]): void {
  const current = getSurfaceData(surfaceId);
  switch (event.op) {
    case 'set_status':
      updatePresenceSurface(surfaceId, { status: String(event.params?.value || event.params?.status || 'ready') });
      break;
    case 'set_expression':
      updatePresenceSurface(surfaceId, { expression: String(event.params?.value || event.params?.expression || 'neutral') });
      break;
    case 'set_subtitle':
      updatePresenceSurface(surfaceId, { subtitle: String(event.params?.text || event.params?.value || '') });
      break;
    case 'clear_subtitle':
      updatePresenceSurface(surfaceId, { subtitle: '' });
      break;
    case 'append_transcript': {
      const transcript = Array.isArray(current.transcript) ? [...current.transcript as Array<{ speaker: string; text: string }>] : [];
      transcript.push({
        speaker: String(event.params?.speaker || 'AI'),
        text: String(event.params?.text || ''),
      });
      updatePresenceSurface(surfaceId, { transcript });
      break;
    }
    case 'clear_transcript':
      updatePresenceSurface(surfaceId, { transcript: [] });
      break;
    default:
      logger.warn(`[presence-studio] unsupported timeline op ${(event as any).op}`);
  }
  state.lastUpdatedAt = new Date().toISOString();
  emitState();
}

function playTimeline(timeline: PresenceTimelineAdf): { accepted: boolean; surfaceId: string; scheduled: number } {
  const surfaceId = timeline.surface_id || 'presence-studio';
  if (timeline.interrupt_policy === 'ignore' && activeTimelineTimers.has(surfaceId)) {
    return { accepted: false, surfaceId, scheduled: 0 };
  }
  clearTimeline(surfaceId);
  if (timeline.title) {
    updatePresenceSurface(surfaceId, { title: timeline.title });
  }
  const timers = timeline.events.map((event) => setTimeout(() => {
    applyTimelineEvent(surfaceId, timeline, event);
  }, event.at_ms));
  activeTimelineTimers.set(surfaceId, timers);
  return { accepted: true, surfaceId, scheduled: timeline.events.length };
}

function broadcast(event: string, payload: unknown): void {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(chunk);
  }
}

function emitState(): void {
  broadcast('state', state);
}

function bootstrapState(): void {
  const messages = buildPresenceSurfaceFrame({
    title: 'Presence Studio',
    status: 'ready',
    expression: 'neutral',
    subtitle: 'Surface ready. Send A2UI or voice stimuli.',
    transcript: [],
  });
  for (const message of messages) applyA2UIMessage(message);
}

bootstrapState();
ensureStimuliDir();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(staticDir));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    surfaces: Object.keys(state.surfaces).length,
    recentStimuli: state.recentStimuli.length,
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
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/a2ui/dispatch', (req, res) => {
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    applyA2UIMessage(message as A2UIMessage);
  }
  emitState();
  res.json({ ok: true, applied: messages.length });
});

app.post('/api/voice/stimuli', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const requestId = typeof req.body?.request_id === 'string' && req.body.request_id.trim()
    ? req.body.request_id.trim()
    : randomUUID();

  const stimulus = createPresenceVoiceStimulus(
    text,
    typeof req.body?.intent === 'string' ? req.body.intent : 'conversation',
    typeof req.body?.source_id === 'string' ? req.body.source_id : 'presence-studio',
    requestId,
  );
  safeAppendFileSync(STIMULI_PATH, `${JSON.stringify(stimulus)}\n`, 'utf8');
  rememberStimulus(stimulus as unknown as Record<string, unknown>);
  emitState();
  return res.status(201).json({ ok: true, request_id: requestId, stimulus });
});

app.post('/api/voice/ingest', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const requestId = typeof req.body?.request_id === 'string' && req.body.request_id.trim()
    ? req.body.request_id.trim()
    : randomUUID();

  const response = await fetch(`${VOICE_HUB_URL}/api/ingest-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: requestId,
      text,
      intent: typeof req.body?.intent === 'string' ? req.body.intent : 'conversation',
      source_id: typeof req.body?.source_id === 'string' ? req.body.source_id : 'browser-mic',
      speaker: typeof req.body?.speaker === 'string' ? req.body.speaker : 'User',
      reflect_to_surface: req.body?.reflect_to_surface !== false,
      auto_reply: req.body?.auto_reply !== false,
    }),
  });

  const payload = await response.text();
  res.status(response.status).type('application/json').send(payload);
});

app.post('/api/voice/native-listen', async (req, res) => {
  const requestId = typeof req.body?.request_id === 'string' && req.body.request_id.trim()
    ? req.body.request_id.trim()
    : randomUUID();

  const response = await fetch(`${VOICE_HUB_URL}/api/listen-once`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: requestId,
      locale: typeof req.body?.locale === 'string' ? req.body.locale : 'ja-JP',
      device_id: typeof req.body?.device_id === 'string' ? req.body.device_id : undefined,
      timeout_seconds: Number.isFinite(req.body?.timeout_seconds) ? Number(req.body.timeout_seconds) : 8,
      intent: typeof req.body?.intent === 'string' ? req.body.intent : 'conversation',
      speaker: typeof req.body?.speaker === 'string' ? req.body.speaker : 'User',
      reflect_to_surface: req.body?.reflect_to_surface !== false,
      auto_reply: req.body?.auto_reply !== false,
    }),
  });

  const payload = await response.text();
  res.status(response.status).type('application/json').send(payload);
});

app.get('/api/voice/input-devices', async (_req, res) => {
  const response = await fetch(`${VOICE_HUB_URL}/api/input-devices`);
  const payload = await response.text();
  res.status(response.status).type('application/json').send(payload);
});

app.post('/api/demo/frame', (req, res) => {
  const messages = buildPresenceSurfaceFrame({
    surfaceId: typeof req.body?.surfaceId === 'string' ? req.body.surfaceId : 'presence-studio',
    title: typeof req.body?.title === 'string' ? req.body.title : 'Presence Studio',
    status: typeof req.body?.status === 'string' ? req.body.status : 'speaking',
    expression: typeof req.body?.expression === 'string' ? req.body.expression : 'joy',
    subtitle: typeof req.body?.subtitle === 'string' ? req.body.subtitle : 'Hello from Kyberion.',
    transcript: Array.isArray(req.body?.transcript) ? req.body.transcript : [{ speaker: 'AI', text: 'Hello from Kyberion.' }],
  });
  for (const message of messages) applyA2UIMessage(message);
  emitState();
  res.json({ ok: true, messages });
});

app.post('/api/timeline/dispatch', (req, res) => {
  const timeline = validatePresenceTimeline(req.body);
  const result = playTimeline(timeline);
  return res.status(result.accepted ? 202 : 409).json({ ok: result.accepted, ...result });
});

app.get('/api/stimuli/tail', (_req, res) => {
  if (!safeExistsSync(STIMULI_PATH)) return res.json({ items: [] });
  const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
  const items = content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-20)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return { raw: line };
      }
    });
  res.json({ items });
});

server.listen(PORT, HOST, () => {
  logger.info(`[presence-studio] listening on http://${HOST}:${PORT}`);
});
