/**
 * Concierge surface — the Sovereign's AI secretary.
 *
 * A lightweight presence surface: a 2.5D avatar + voice/text conversation.
 * Light requests are answered directly (direct_reply); heavy ones auto-promote
 * to task_session/mission — all decided by the existing orchestrator.
 *
 * Design (2026-07-03 re-implementation, Fable 5): NO single point of failure.
 *   Primary path  — voice-hub /api/ingest-text: richest experience (greeting /
 *                   capability chit-chat via buildVoiceFallbackReply, orchestrator,
 *                   server-side TTS, presence reflection).
 *   Fallback path — if voice-hub is unreachable/errors, LAZILY import @agent/core
 *                   and call runSurfaceMessageConversation directly (the same entry
 *                   chronos uses), so knowledge queries and mission promotion still
 *                   work without a second daemon. The heavy orchestrator is only
 *                   loaded when we must degrade, keeping the happy path light.
 *   Both fail     — a clear, actionable user message (never a silent failure).
 *
 * Self-contained, no per-surface deps; compiled by root tsc to
 * dist/presence/displays/concierge/server.js. Binds to 127.0.0.1 only.
 */
import express from 'express';
import { createServer } from 'node:http';
import * as path from 'node:path';
import { pathResolver } from '@agent/core';

const app = express();
app.use(express.json({ limit: '256kb' }));

const staticDir = path.join(pathResolver.rootDir(), 'presence/displays/concierge/static');
const PORT = Number(process.env.PRESENCE_CONCIERGE_PORT || 3033);
const HOST = process.env.PRESENCE_CONCIERGE_HOST || '127.0.0.1';
const VOICE_HUB_URL = process.env.VOICE_HUB_URL || 'http://127.0.0.1:3032';

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[concierge] ${msg}`);
}

/** Best-effort reachability probe of voice-hub (short timeout). */
async function voiceHubReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${VOICE_HUB_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Primary path: voice-hub (rich reply + TTS + presence reflection). */
async function replyViaVoiceHub(text: string, speaker: string): Promise<string> {
  const resp = await fetch(`${VOICE_HUB_URL}/api/ingest-text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      intent: 'conversation',
      source_id: 'concierge',
      speaker,
      reflect_to_surface: true,
      auto_reply: true,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`voice-hub responded ${resp.status}`);
  const data: any = await resp.json();
  return String(data.reply ?? data.text ?? data.response ?? '').trim();
}

/** Fallback path: call the orchestrator directly (lazy-loaded @agent/core). */
async function replyViaOrchestrator(text: string, speaker: string): Promise<string> {
  const core: any = await import('@agent/core');
  const conversation = await core.runSurfaceMessageConversation({
    surface: 'presence',
    text,
    senderAgentId: 'kyberion:concierge',
    agentId: 'presence-surface-agent',
    actorId: speaker,
    cwd: pathResolver.rootDir(),
  });
  return String(conversation?.text ?? '').trim();
}

app.get('/health', async (_req, res) => {
  const reachable = await voiceHubReachable();
  res.json({
    status: 'ok',
    surface: 'concierge',
    voiceHub: VOICE_HUB_URL,
    voiceHubReachable: reachable,
    // conversations work either way: rich via voice-hub, degraded via orchestrator.
    conversationMode: reachable ? 'voice-hub' : 'orchestrator-fallback',
  });
});

// Primary conversation entrypoint. Tries voice-hub, then degrades to the
// orchestrator, then fails loudly (never silently).
app.post('/api/message', async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) {
    res.status(400).json({ error: 'text_required', message: 'メッセージが空です。' });
    return;
  }
  const speaker = String((req.body && req.body.speaker) || 'Sovereign');

  // Try voice-hub first (rich path).
  try {
    const reply = await replyViaVoiceHub(text, speaker);
    res.json({ reply, source: 'voice-hub', degraded: false });
    return;
  } catch (err) {
    log(`voice-hub path failed (${(err as Error)?.message ?? err}); falling back to orchestrator`);
  }

  // Degrade to the orchestrator directly (no voice-hub needed).
  try {
    const reply = await replyViaOrchestrator(text, speaker);
    if (!reply) throw new Error('empty orchestrator reply');
    res.json({
      reply,
      source: 'orchestrator-fallback',
      degraded: true,
      notice: '音声ハブが未起動のため簡易応答です(音声読み上げ・表情反映は無効)。',
    });
    return;
  } catch (err) {
    log(`orchestrator fallback failed (${(err as Error)?.message ?? err})`);
  }

  // Both paths failed — clear, actionable message (UX-01: no silent failure).
  res.status(503).json({
    error: 'concierge_unavailable',
    message:
      '秘書がただ今応答できません。推論バックエンドまたは音声ハブの起動状況をご確認ください(`pnpm reasoning:setup` / voice-hub)。',
  });
});

app.use(express.static(staticDir));

const server = createServer(app);
server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (voice-hub: ${VOICE_HUB_URL})`);
});
