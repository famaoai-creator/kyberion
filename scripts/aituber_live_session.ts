/**
 * AITuber live session — YouTube live-chat → reply → voice → presence loop.
 *
 * Polls `liveChatMessages.list` (YouTube Data API v3, read-only), turns each
 * new viewer message into a spoken reply through the same realtime-voice
 * pipeline the mic loop uses, and reflects the turn on the presence surface
 * so the avatar's face stays in sync for OBS.
 *
 *   comments ──poll──▶ dedupe ──▶ generateRealtimeAssistantReply
 *        │                            │
 *        │                            ▼
 *        │                     synthesizeRealtimeVoice (TTS artifact)
 *        │                            │
 *        └──────────────▶ reflectPresenceAgentReply (avatar face)
 *
 * The API key is resolved via the secret resolver (`KYBERION_YOUTUBE_API_KEY`),
 * never from argv or repo files. `--fixture <json>` replaces the API entirely
 * (array of {id, author, text}) so the loop is hermetically testable and can
 * be rehearsed without a live broadcast.
 *
 * Usage:
 *   node --import ./scripts/ts-loader.mjs scripts/aituber_live_session.ts \
 *     --session-id aoi-live --live-chat-id <chatId> \
 *     --profile-id irodori-ja-small --avatar-agent-id aituber-aoi
 */

import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript } from './lib/harness.js';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { readJson } from '@agent/core/foundation/json';
import { pathResolver } from '@agent/core/path-resolver';
import { logger } from '@agent/core/core';
import {
  ensureRealtimeVoiceConversationSession,
  generateRealtimeAssistantReply,
  recordRealtimeVoiceConversationExchange,
  synthesizeRealtimeVoice,
} from '@agent/core/voice/realtime-voice-conversation';
import { reflectPresenceAgentReply } from '@agent/core/presence-bridge';
import { getSecret } from '@agent/core/secret/secret-guard';
import { installReasoningBackends } from '@agent/core/reasoning/reasoning-bootstrap';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3/liveChatMessages';
const DEFAULT_POLL_INTERVAL_MS = 5000;

export interface LiveChatMessage {
  id: string;
  author: string;
  text: string;
}

export interface AituberLiveSessionOptions {
  sessionId: string;
  liveChatId?: string;
  fixturePath?: string;
  profileId?: string;
  language?: string;
  assistantName: string;
  avatarAgentId?: string;
  systemPrompt?: string;
  surfaceId: string;
  pollIntervalMs: number;
  maxTurns: number;
  deliveryMode: 'none' | 'artifact' | 'artifact_and_playback';
  personalVoiceMode: 'allow_fallback' | 'require_personal_voice';
  dryRun: boolean;
}

interface Deps {
  fetchImpl?: typeof fetch;
  replyFn?: typeof generateRealtimeAssistantReply;
  speakFn?: typeof synthesizeRealtimeVoice;
  presenceFn?: typeof reflectPresenceAgentReply;
  apiKeyResolver?: () => string | null;
  sleep?: (ms: number) => Promise<void>;
}

const SEEN_ID_CAP = 5000;
const FETCH_TIMEOUT_MS = 15000;

function parseYoutubeMessages(payload: unknown): LiveChatMessage[] {
  const items = (payload as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  const out: LiveChatMessage[] = [];
  for (const item of items) {
    const rec = item as Record<string, unknown>;
    const snippet = rec.snippet as Record<string, unknown> | undefined;
    const author = rec.authorDetails as Record<string, unknown> | undefined;
    const text = snippet?.displayMessage;
    if (typeof rec.id === 'string' && typeof text === 'string' && text.trim()) {
      out.push({
        id: rec.id,
        author: String(author?.displayName || 'viewer'),
        text: String(text),
      });
    }
  }
  return out;
}

function loadFixtureMessages(fixturePath: string): LiveChatMessage[] {
  const resolved = assertSafeRepositoryPath(pathResolver.rootResolve(fixturePath));
  const parsed = readJson(resolved) as unknown;
  const list = Array.isArray(parsed) ? parsed : (parsed as { messages?: unknown[] }).messages;
  if (!Array.isArray(list)) throw new Error('fixture must be an array or {messages:[...]}');
  return list.map((m, i) => {
    const rec = m as Record<string, unknown>;
    return {
      id: String(rec.id ?? `fx-${i}`),
      author: String(rec.author ?? 'viewer'),
      text: String(rec.text ?? ''),
    };
  });
}

async function fetchLiveChatPage(
  liveChatId: string,
  apiKey: string,
  pageToken: string | undefined,
  fetchImpl: typeof fetch
): Promise<{ messages: LiveChatMessage[]; nextPageToken?: string; pollMs?: number }> {
  const url = new URL(YOUTUBE_API_BASE);
  url.searchParams.set('liveChatId', liveChatId);
  url.searchParams.set('part', 'snippet,authorDetails');
  url.searchParams.set('key', apiKey);
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  const res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`youtube_api_http_${res.status}`);
  const payload = (await res.json()) as {
    nextPageToken?: string;
    pollingIntervalMillis?: number;
  };
  return {
    messages: parseYoutubeMessages(payload),
    nextPageToken: payload.nextPageToken,
    pollMs:
      typeof payload.pollingIntervalMillis === 'number' && payload.pollingIntervalMillis > 0
        ? payload.pollingIntervalMillis
        : undefined,
  };
}

export async function runAituberLiveSession(
  options: AituberLiveSessionOptions,
  deps: Deps = {},
  print: (v: unknown) => void = (v) => logger.info(String(v))
): Promise<{ turns: number; processed: string[] }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const replyFn = deps.replyFn ?? generateRealtimeAssistantReply;
  const speakFn = deps.speakFn ?? synthesizeRealtimeVoice;
  const presenceFn = deps.presenceFn ?? reflectPresenceAgentReply;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const session = ensureRealtimeVoiceConversationSession({
    sessionId: options.sessionId,
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    assistantName: options.assistantName,
    personalVoiceMode: options.personalVoiceMode,
  });

  const resolveApiKey =
    deps.apiKeyResolver ??
    (() =>
      getRegisteredEnvText('KYBERION_YOUTUBE_API_KEY') || getSecret('KYBERION_YOUTUBE_API_KEY'));
  const apiKey = options.fixturePath ? '' : resolveApiKey() || '';
  if (!options.fixturePath && !apiKey) {
    throw new Error(
      'KYBERION_YOUTUBE_API_KEY is not configured (register it via the secret resolver) or pass --fixture'
    );
  }
  if (!options.fixturePath && !options.liveChatId) {
    throw new Error('--live-chat-id is required without --fixture');
  }

  const seen = new Set<string>();
  const processed: string[] = [];
  let pageToken: string | undefined;
  let turns = 0;

  let nextPollMs = options.pollIntervalMs;
  const takeMessages = async (): Promise<LiveChatMessage[]> => {
    if (options.fixturePath) {
      const all = loadFixtureMessages(options.fixturePath);
      return all.filter((m) => !seen.has(m.id));
    }
    const page = await fetchLiveChatPage(options.liveChatId!, apiKey, pageToken, fetchImpl);
    pageToken = page.nextPageToken;
    if (page.pollMs) nextPollMs = page.pollMs;
    return page.messages.filter((m) => !seen.has(m.id));
  };
  const markSeen = (id: string): void => {
    seen.add(id);
    if (seen.size > SEEN_ID_CAP) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  };

  while (turns < options.maxTurns) {
    let incoming: LiveChatMessage[] = [];
    try {
      incoming = await takeMessages();
    } catch (error: unknown) {
      logger.warn(
        `[aituber-live] poll failed, retrying in ${nextPollMs}ms: ${error instanceof Error ? error.message : String(error)}`
      );
      await sleep(nextPollMs);
      continue;
    }
    for (const msg of incoming) {
      if (turns >= options.maxTurns) break;
      markSeen(msg.id);
      try {
        const assistantText = options.dryRun
          ? `[dry-run] ${msg.text}`
          : await replyFn(session.session_id, `${msg.author}: ${msg.text}`);
        let audioRef: string | undefined;
        if (!options.dryRun && options.deliveryMode !== 'none') {
          const synth = await speakFn({
            sessionId: session.session_id,
            profileId: session.profile_id,
            language: options.language || session.language,
            text: assistantText,
            deliveryMode: options.deliveryMode,
            personalVoiceMode: options.personalVoiceMode,
            requestTag: `live-${msg.id.replace(/[^\w-]/g, '_')}`,
          });
          audioRef = synth.artifactPath;
        }
        recordRealtimeVoiceConversationExchange({
          sessionId: session.session_id,
          userText: `${msg.author}: ${msg.text}`,
          assistantText,
          assistantAudioRef: audioRef,
        });
        void presenceFn({
          agentId: options.avatarAgentId || 'presence-surface-agent',
          surfaceId: options.surfaceId,
          text: assistantText,
          speaker: session.assistant_name,
        }).catch(() => {
          /* presence surface is best effort */
        });
        print(`${msg.author}: ${msg.text}`);
        print(`${session.assistant_name}: ${assistantText}`);
        processed.push(msg.id);
        turns += 1;
      } catch (error: unknown) {
        logger.warn(
          `[aituber-live] message ${msg.id} skipped: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (options.fixturePath) break; // fixtures are single-pass
    if (incoming.length === 0) await sleep(nextPollMs);
  }
  return { turns, processed };
}

export async function main(argv: string[], print: (v: unknown) => void): Promise<void> {
  const parsed = await createStandardYargs(['node', 'aituber_live_session', ...argv])
    .exitProcess(false)
    .option('session-id', { type: 'string', demandOption: true })
    .option('live-chat-id', { type: 'string' })
    .option('fixture', { type: 'string' })
    .option('profile-id', { type: 'string', alias: 'voice-profile-id' })
    .option('language', { type: 'string' })
    .option('assistant-name', { type: 'string', default: 'Aoi' })
    .option('avatar-agent-id', { type: 'string' })
    .option('system-prompt', { type: 'string' })
    .option('surface-id', { type: 'string', default: 'presence-studio' })
    .option('poll-interval-ms', { type: 'number', default: DEFAULT_POLL_INTERVAL_MS })
    .option('max-turns', { type: 'number', default: 50 })
    .option('delivery-mode', {
      type: 'string',
      choices: ['none', 'artifact', 'artifact_and_playback'],
      default: 'artifact',
    })
    .option('personal-voice-mode', {
      type: 'string',
      choices: ['allow_fallback', 'require_personal_voice'],
      default: 'allow_fallback',
    })
    .option('dry-run', { type: 'boolean', default: false })
    .parse();
  if (parsed.help || parsed.h) return;
  // A dry-run rehearsal never reaches a reasoning or TTS backend, so the
  // credential-bound bootstrap is skipped.
  if (!parsed['dry-run']) installReasoningBackends();
  const result = await runAituberLiveSession(
    {
      sessionId: String(parsed['session-id']),
      ...(parsed['live-chat-id'] ? { liveChatId: String(parsed['live-chat-id']) } : {}),
      ...(parsed.fixture ? { fixturePath: String(parsed.fixture) } : {}),
      ...(parsed['profile-id'] ? { profileId: String(parsed['profile-id']) } : {}),
      ...(parsed.language ? { language: String(parsed.language) } : {}),
      assistantName: String(parsed['assistant-name']),
      ...(parsed['avatar-agent-id'] ? { avatarAgentId: String(parsed['avatar-agent-id']) } : {}),
      ...(parsed['system-prompt'] ? { systemPrompt: String(parsed['system-prompt']) } : {}),
      surfaceId: String(parsed['surface-id']),
      pollIntervalMs: Number(parsed['poll-interval-ms']),
      maxTurns: Number(parsed['max-turns']),
      deliveryMode: parsed['delivery-mode'] as AituberLiveSessionOptions['deliveryMode'],
      personalVoiceMode: parsed[
        'personal-voice-mode'
      ] as AituberLiveSessionOptions['personalVoiceMode'],
      dryRun: Boolean(parsed['dry-run']),
    },
    {},
    print
  );
  print(JSON.stringify(result));
}

const aituberLiveSessionScript = defineScript({
  name: 'aituber_live_session',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'aituber_live_session.ts') ||
  isDirectScript(import.meta.url, 'aituber_live_session.js')
) {
  void aituberLiveSessionScript();
}
