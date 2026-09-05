import { appendJsonLine } from './foundation/json.js';
/* eslint-disable no-restricted-imports */
/**
 * ChromeExtensionMeetingJoinDriver — browser meeting attendance driven through
 * a user-loaded Chrome extension (the "Meet Copilot" extension in
 * tools/meet-copilot-extension), instead of Playwright/CDP.
 *
 * Why: Playwright/CDP sessions are rejected by Google Meet's bot detection.
 * A real, signed-in Chrome operated by the user's own extension is not.
 *
 * Control plane (inverted vs the native-messaging browser-bridge, which is
 * extension-initiated): this driver runs a LOCAL WebSocket server; the
 * extension's service worker connects to it and receives commands
 * (join / set_mic / set_camera / chat / leave) which the content script
 * executes against the Meet DOM by accessible-name. The extension streams
 * back events (ready / joined / caption / left / error).
 *
 * Audio is decoupled (same as the Playwright driver): the returned
 * MeetingSession pipes the supplied AudioBus (BlackHole) through — the user
 * routes Chrome's meeting audio to the virtual device. As a bonus, Meet's own
 * live captions scraped by the content script are persisted to a JSONL file so
 * a transcript is available even without a local STT model.
 */

import type { AudioBus } from './audio-bus.js';
import { randomBytes } from 'node:crypto';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonObjectInput } from './foundation/safe-json.js';
import { nowIso } from './foundation/time.js';
import { createLogger } from './logger.js';
import { ocrImage } from './ocr-bridge.js';
import { pathResolver } from './path-resolver.js';
import { scrubContent } from './pii-scrubber.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import type { MeetingJoinDriver } from './meeting-join-driver.js';
import { registerMeetingJoinDriver } from './meeting-join-driver.js';
import type {
  AudioChunk,
  AudioFormat,
  MeetingSession,
  MeetingSessionState,
  MeetingTarget,
  TranscriptChunk,
} from './meeting-session-types.js';
import { abortableAudioChunks } from './meeting-session-types.js';

export interface ChromeExtensionMeetingDriverOptions {
  /** Loopback port the driver listens on and the extension connects to. */
  wsPort?: number;
  /** Loopback host. Default 127.0.0.1. */
  wsHost?: string;
  /** Seconds to wait for the extension to connect + report the join. */
  joinTimeoutSec?: number;
  /** Start muted (listen-only, transcribe-first). Default true. */
  startMuted?: boolean;
  /** Start with camera off. Default true. */
  cameraOff?: boolean;
  /** Pre-shared extension credential. Falls back to KYBERION_MEET_EXTENSION_TOKEN. */
  wsAuthToken?: string;
}

const DEFAULT_PORT = 8779;
const DEFAULT_HOST = '127.0.0.1';
const logger = createLogger('meet-ext');
const AI_PROVIDERS = new Set(['chrome-summarizer', 'chrome-prompt']);
const AI_MODES = new Set(['full', 'rolling']);
const MAX_AI_TEXT = 12_000;

interface ExtensionEvent {
  event: string;
  [k: string]: unknown;
}

export function parseChromeExtensionEvent(raw: string): ExtensionEvent | undefined {
  try {
    const parsed = parseSafeJsonObjectInput(raw, 'Chrome extension event');
    if (!parsed || typeof parsed.event !== 'string' || !parsed.event.trim()) return undefined;
    return parsed as ExtensionEvent;
  } catch {
    return undefined;
  }
}

// Minimal structural type so we don't hard-fail typecheck if `ws` types drift.
interface WsLike {
  send(data: string): void;
  close(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}
interface WsServerLike {
  on(event: string, cb: (...args: unknown[]) => void): void;
  close(cb?: () => void): void;
}

function resolveExtensionAuthToken(options: ChromeExtensionMeetingDriverOptions): string {
  const token =
    options.wsAuthToken?.trim() || getRegisteredEnvText('KYBERION_MEET_EXTENSION_TOKEN')?.trim();
  if (!token || token.length < 32) {
    throw new Error(
      'Meet extension authentication is not configured. Set KYBERION_MEET_EXTENSION_TOKEN (32+ characters) and the same meetCopilotAuthToken in Chrome storage.'
    );
  }
  return token;
}

function redactMeetingText(value: unknown): string {
  try {
    return scrubContent(String(value ?? '')).scrubbed_text.trim();
  } catch {
    return '[REDACTED:pii-scrubber-unavailable]';
  }
}

function validAiEvent(event: ExtensionEvent): boolean {
  if (!AI_PROVIDERS.has(String(event.provider || ''))) return false;
  if (event.event === 'ai_summary') {
    return (
      typeof event.text === 'string' &&
      event.text.length <= MAX_AI_TEXT &&
      AI_MODES.has(String(event.mode || ''))
    );
  }
  if (event.event === 'ai_insights') {
    return (
      event.insights !== null &&
      typeof event.insights === 'object' &&
      JSON.stringify(event.insights).length <= 32_000
    );
  }
  if (event.event === 'ai_suggestions') {
    return (
      Array.isArray(event.suggestions) &&
      event.suggestions.length <= 4 &&
      JSON.stringify(event.suggestions).length <= 8_000
    );
  }
  return false;
}

export class ChromeExtensionMeetingJoinDriver implements MeetingJoinDriver {
  readonly driver_id = 'chrome-extension';
  readonly supported_platforms = ['meet', 'teams', 'zoom', 'auto'] as const;

  constructor(private readonly options: ChromeExtensionMeetingDriverOptions = {}) {}

  async probe(): Promise<{ available: boolean; reason?: string }> {
    try {
      await import('ws');
    } catch (err) {
      return {
        available: false,
        reason: `ws module not available (${(err as Error).message}); required for the extension control channel`,
      };
    }
    return { available: true };
  }

  async join(target: MeetingTarget, bus: AudioBus): Promise<MeetingSession> {
    const port = this.options.wsPort ?? DEFAULT_PORT;
    const host = this.options.wsHost ?? DEFAULT_HOST;
    const joinTimeoutMs = (this.options.joinTimeoutSec ?? 120) * 1000;
    const startMuted = this.options.startMuted !== false;
    const cameraOff = this.options.cameraOff !== false;
    const authToken = resolveExtensionAuthToken(this.options);

    const { WebSocketServer } = (await import('ws')) as unknown as {
      WebSocketServer: new (opts: { host: string; port: number }) => WsServerLike;
    };

    const captionsDir = pathResolver.shared('tmp');
    safeMkdir(captionsDir, { recursive: true });
    const sessionId = `meet-ext-${Date.now().toString(36)}`;
    const captionsPath = pathResolver.shared(`tmp/meeting-captions-${sessionId}.jsonl`);
    const diagnosticsPath = pathResolver.shared(`tmp/meeting-diagnostics-${sessionId}.json`);
    const summaryPath = pathResolver.shared(`tmp/meeting-summary-${sessionId}.json`);
    const controlToken = randomBytes(32).toString('hex');

    // On-device (Gemini Nano) output produced in the extension's side panel.
    // The driver only persists it: it is a review artifact, never an input to
    // the meeting, and the model never ran on this side of the channel.
    const AI_EVENT_KINDS: Record<string, 'summary' | 'insights' | 'suggestions'> = {
      ai_summary: 'summary',
      ai_insights: 'insights',
      ai_suggestions: 'suggestions',
    };
    const MAX_AI_HISTORY = 100;
    const aiDocument: {
      session_id: string;
      source: string;
      updated_at: string;
      summary: Record<string, unknown> | null;
      insights: Record<string, unknown> | null;
      suggestions: Record<string, unknown> | null;
      history: Array<Record<string, unknown>>;
      screen_context: Array<Record<string, unknown>>;
    } = {
      session_id: sessionId,
      source: 'chrome-built-in-ai',
      updated_at: nowIso(),
      summary: null,
      insights: null,
      suggestions: null,
      history: [],
      screen_context: [],
    };
    const writeAiDocument = (at?: string): void => {
      aiDocument.updated_at = at ?? nowIso();
      safeWriteFile(summaryPath, `${JSON.stringify(aiDocument, null, 2)}\n`);
    };
    // Shared-screen frames. A frame bypasses the text PII scrubber entirely, so
    // it is never sent anywhere: it is written locally, read by an OCR provider
    // pinned to `local_only` (declared dataEgress 'none'), and the extracted
    // text is scrubbed before it is stored or handed back to the extension. The
    // frames themselves are deleted when the session ends.
    const framesDir = `tmp/meeting-frames-${sessionId}`;
    let frameSeq = 0;
    const MAX_SCREEN_CONTEXT = 40;

    const recordAiEvent = (kind: 'summary' | 'insights' | 'suggestions', e: ExtensionEvent) => {
      const { event: _event, control_token: _token, ...payload } = e;
      const entry = { kind, ...payload, received_at: nowIso() };
      aiDocument[kind] = entry;
      aiDocument.history.push(entry);
      if (aiDocument.history.length > MAX_AI_HISTORY) {
        aiDocument.history.splice(0, aiDocument.history.length - MAX_AI_HISTORY);
      }
      writeAiDocument(entry.received_at);
      logger.info(`on-device AI ${kind} recorded → ${summaryPath}`);
    };

    /**
     * Read one shared-screen frame locally and return only redacted text.
     * Fails closed: if no on-device OCR provider is available, or the one that
     * served the request does not declare zero egress, the frame is dropped
     * rather than read by anything that could ship it off the machine.
     */
    const readFrameLocally = async (
      e: ExtensionEvent
    ): Promise<{ text: string; provider: string } | null> => {
      const dataUrl = typeof e.data_url === 'string' ? e.data_url : '';
      const parsed = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!parsed) {
        logger.warn('frame event ignored: not a base64 png/jpeg data URL');
        return null;
      }
      safeMkdir(pathResolver.shared(framesDir), { recursive: true });
      frameSeq += 1;
      const frameFile = `${framesDir}/frame-${String(frameSeq).padStart(4, '0')}.${
        parsed[1] === 'png' ? 'png' : 'jpg'
      }`;
      safeWriteFile(pathResolver.shared(frameFile), Buffer.from(parsed[2], 'base64'));

      const ocr = await ocrImage({
        path: pathResolver.shared(frameFile),
        language: 'ja-JP',
        mode: 'local_only',
      });
      if (ocr.providerDataEgress !== 'none') {
        throw new Error(
          `OCR provider '${ocr.provider}' served a meeting frame with egress '${ocr.providerDataEgress}'`
        );
      }
      const text = scrubContent(ocr.text || '').scrubbed_text.trim();
      aiDocument.screen_context.push({
        at: nowIso(),
        frame: frameFile,
        provider: ocr.provider,
        provider_data_egress: ocr.providerDataEgress,
        confidence: ocr.confidence,
        text,
      });
      if (aiDocument.screen_context.length > MAX_SCREEN_CONTEXT) {
        aiDocument.screen_context.splice(0, aiDocument.screen_context.length - MAX_SCREEN_CONTEXT);
      }
      // No recorded event to borrow a timestamp from here: the frame read is its
      // own occurrence, so wall-clock now is the honest updated_at.
      writeAiDocument();
      logger.info(
        `screen frame read on-device (provider=${ocr.provider}, ${text.length} chars after redaction)`
      );
      return { text, provider: ocr.provider };
    };

    const state: MeetingSessionState = {
      session_id: sessionId,
      platform: 'meet',
      status: 'connecting',
      joined_at: nowIso(),
    };

    const wss = new WebSocketServer({ host, port });
    let socket: WsLike | null = null;
    const eventWaiters = new Map<string, Array<(e: ExtensionEvent) => void>>();

    // Live-caption stream state: caption events double as a driver-native
    // transcript so the coordinator can run captions_first (no local STT).
    const captionQueue: TranscriptChunk[] = [];
    let captionWaiter: (() => void) | null = null;
    let captionSeq = 0;
    let lastCaptionText = '';
    const wakeCaptionWaiter = (): void => {
      const waiter = captionWaiter;
      captionWaiter = null;
      waiter?.();
    };
    const pushCaption = (text: string, speaker?: string): void => {
      const trimmed = text.trim();
      // Platforms re-emit the growing caption line; only forward changes.
      if (!trimmed || trimmed === lastCaptionText) return;
      lastCaptionText = trimmed;
      captionSeq += 1;
      captionQueue.push({
        utterance_id: `${sessionId}-cap-${captionSeq}`,
        is_final: true,
        text: trimmed,
        ...(speaker ? { speaker_label: speaker } : {}),
        emitted_at: nowIso(),
      });
      wakeCaptionWaiter();
    };

    const onEvent = (name: string, cb: (e: ExtensionEvent) => void): void => {
      const list = eventWaiters.get(name) ?? [];
      list.push(cb);
      eventWaiters.set(name, list);
    };
    const waitEvent = (name: string, timeoutMs: number): Promise<ExtensionEvent> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for extension event '${name}'`)),
          timeoutMs
        );
        onEvent(name, (e) => {
          clearTimeout(timer);
          resolve(e);
        });
      });
    const dispatch = (e: ExtensionEvent): void => {
      const list = eventWaiters.get(e.event);
      if (list && list.length > 0) {
        eventWaiters.set(e.event, []);
        for (const cb of list) cb(e);
      }
    };

    const send = (cmd: Record<string, unknown>): void => {
      if (!socket) throw new Error('extension is not connected to the control channel');
      socket.send(JSON.stringify(cmd));
    };

    const joinCmd = {
      cmd: 'join',
      url: target.url,
      platform: target.platform ?? 'auto',
      display_name: target.display_name ?? 'Kyberion',
      mic: startMuted ? 'off' : 'on',
      camera: cameraOff ? 'off' : 'on',
      captions: true,
      control_token: controlToken,
    };

    let joinAcked = false;
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `no Chrome extension connected on ws://${host}:${port} within ${joinTimeoutMs / 1000}s. ` +
                `Load tools/meet-copilot-extension in Chrome and open the Meet tab.`
            )
          ),
        joinTimeoutMs
      );
      // Re-issue join on (re)connection ONLY until it is acknowledged, so the
      // operator can reload the extension before joining — but we never re-issue
      // join once in-call (repeated joins destabilize the Meet session).
      wss.on('connection', (...args: unknown[]) => {
        const candidate = args[0] as WsLike;
        let authenticated = false;
        candidate.on('message', (...margs: unknown[]) => {
          try {
            const parsed = parseChromeExtensionEvent(String(margs[0]));
            if (!parsed) return;
            if (!authenticated) {
              if (parsed.event !== 'hello' || parsed.auth_token !== authToken) {
                candidate.close();
                return;
              }
              authenticated = true;
              socket = candidate;
              clearTimeout(timer);
              if (joinAcked) {
                // Rehydrate a restarted MV3 worker without re-running the
                // meeting join flow, which can destabilize an active call.
                candidate.send(JSON.stringify({ cmd: 'session', control_token: controlToken }));
              } else {
                logger.info(`authenticated Meet extension on ws://${host}:${port}; issuing join`);
                candidate.send(JSON.stringify(joinCmd));
              }
              resolve();
              return;
            }
            if (candidate !== socket) return;
            if (parsed.control_token !== controlToken) return;
            if (parsed.event?.startsWith('ai_') && !validAiEvent(parsed)) {
              logger.warn(`ignored invalid AI event from extension: ${String(parsed.event)}`);
              return;
            }
            if (parsed.event === 'joined') joinAcked = true;
            if (parsed.event === 'caption') {
              const { control_token: _token, ...caption } = parsed;
              const safeCaption = {
                ...caption,
                ...(typeof parsed.text === 'string'
                  ? { text: redactMeetingText(parsed.text) }
                  : {}),
                ...(typeof parsed.speaker === 'string'
                  ? { speaker: redactMeetingText(parsed.speaker) }
                  : {}),
              };
              appendJsonLine(captionsPath, { ...safeCaption, ts: nowIso() });
              pushCaption(
                typeof safeCaption.text === 'string' ? safeCaption.text : '',
                typeof safeCaption.speaker === 'string' ? safeCaption.speaker : undefined
              );
            }
            if (parsed.event === 'diagnostics') {
              safeWriteFile(diagnosticsPath, `${JSON.stringify(parsed.data ?? parsed, null, 2)}\n`);
              logger.info(`DOM diagnostics captured → ${diagnosticsPath}`);
            }
            const aiKind = AI_EVENT_KINDS[parsed.event];
            if (aiKind) recordAiEvent(aiKind, parsed);
            if (parsed.event === 'frame') {
              // OCR takes ~a second; never block the control channel on it.
              void readFrameLocally(parsed)
                .then((read) => {
                  if (read) send({ cmd: 'screen_context', ...read });
                })
                .catch((err: unknown) => {
                  logger.warn(`screen frame read failed: ${(err as Error).message}`);
                });
            }
            if (parsed.event === 'status') {
              logger.info(
                `meeting status: ${String(parsed.phase ?? '')} ${JSON.stringify(parsed.detail ?? {})}`
              );
            }
            if (parsed.event === 'error') {
              logger.warn(`extension error: ${String(parsed.message ?? parsed.detail ?? '')}`);
            }
            dispatch(parsed);
          } catch {
            /* ignore malformed frames */
          }
        });
        candidate.on('close', () => {
          if (candidate === socket) state.status = state.status === 'ended' ? 'ended' : 'error';
        });
      });
      wss.on('error', (...eargs: unknown[]) => {
        clearTimeout(timer);
        reject(eargs[0] as Error);
      });
    });

    await connected;
    state.status = 'connecting';

    const joined = await waitEvent('joined', joinTimeoutMs).catch((err) => {
      throw new Error(`extension failed to join the meeting: ${(err as Error).message}`);
    });
    state.status = 'in_meeting';
    logger.info(
      `joined meeting (captions → ${captionsPath}) detail=${JSON.stringify(joined.detail ?? {})}`
    );

    // Open the audio bus defensively (idempotent per AudioBus contract).
    const format: AudioFormat = { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 };
    try {
      await bus.open(format);
    } catch (err) {
      logger.warn(
        `audio bus open failed (continuing; coordinator may have opened it): ${(err as Error).message}`
      );
    }

    let left = false;
    return {
      state,
      async *audioInput(): AsyncIterable<AudioChunk> {
        for await (const chunk of bus.inputStream()) {
          if (left) return;
          yield chunk;
        }
      },
      audioOutput: async (
        stream: AsyncIterable<AudioChunk>,
        signal?: AbortSignal
      ): Promise<void> => {
        // Speaking: the AI's TTS PCM is written to the bus (BlackHole), which the
        // operator has set as Chrome's microphone input for the meeting.
        await bus.writeOutput(abortableAudioChunks(stream, signal));
      },
      chat: async (text: string): Promise<void> => {
        try {
          send({ cmd: 'chat', text });
        } catch (err) {
          logger.warn(`chat send failed: ${(err as Error).message}`);
        }
      },
      async *transcriptInput(): AsyncIterable<TranscriptChunk> {
        while (!left) {
          while (captionQueue.length > 0) {
            yield captionQueue.shift() as TranscriptChunk;
          }
          if (left) return;
          const hadCaption = await new Promise<boolean>((resolve) => {
            captionWaiter = () => resolve(true);
            // Heartbeat so the consumer can enforce its deadline during
            // long silences; non-final chunks are skipped by the agent loop.
            const timer = setTimeout(() => resolve(false), 30_000);
            (timer as { unref?: () => void }).unref?.();
          });
          if (!hadCaption && !left) {
            captionSeq += 1;
            yield {
              utterance_id: `${sessionId}-tick-${captionSeq}`,
              is_final: false,
              text: '',
              emitted_at: nowIso(),
            };
          }
        }
      },
      leave: async (): Promise<void> => {
        left = true;
        wakeCaptionWaiter();
        try {
          // Register the waiter BEFORE sending so a fast 'left' reply isn't missed.
          const leftAck = waitEvent('left', 5_000).catch(() => undefined);
          send({ cmd: 'leave' });
          await leftAck;
        } catch {
          /* best-effort leave */
        } finally {
          state.status = 'ended';
          state.left_at = nowIso();
          // Raw frames are working material for the OCR step only. What survives
          // the session is the redacted text in the summary document.
          if (frameSeq > 0) {
            try {
              safeRmSync(pathResolver.shared(framesDir));
              logger.info(`discarded ${frameSeq} shared-screen frame(s)`);
            } catch (err) {
              logger.warn(`could not discard shared-screen frames: ${(err as Error).message}`);
            }
          }
          try {
            socket?.close();
          } catch {
            /* noop */
          }
          // Guard wss.close: the callback may not fire while a client socket
          // lingers, so cap the wait.
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 2_000);
            wss.close(() => {
              clearTimeout(t);
              resolve();
            });
          });
          await bus.close().catch(() => undefined);
        }
      },
    };
  }
}

export function installChromeExtensionMeetingJoinDriver(
  options?: ChromeExtensionMeetingDriverOptions
): void {
  registerMeetingJoinDriver(new ChromeExtensionMeetingJoinDriver(options));
}
