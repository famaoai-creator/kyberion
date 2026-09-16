/**
 * server.ts — meeting-notepad localhost pad (sketch-input twin)
 *
 * Serves a meeting capture pad on 127.0.0.1: notes, voice, continuous
 * recording (+ STT), camera/file attachments, create-minutes, and handoff.
 *
 * Usage:
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/meeting-notepad/server.ts \
 *     [--out <dir>] [--instruction <text>] [--title <text>] [port]
 */
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { safeWriteFile, safeMkdir } from '@agent/core/secure-io';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import {
  portableProtocolServicePathRef,
  recordProtocolServiceLifecycle,
} from '@agent/core/protocol-service-lifecycle';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveTenant } from '@agent/core/tenant-registry';
import { t as catalogT } from '@agent/core/t';
import { getSpeechToTextBridge } from '@agent/core/speech-to-text-bridge';
import {
  createMeetingNotepadContext,
  meetingNotepadHandoffLogicalPath,
  meetingNotepadReceiptLogicalPath,
  meetingNotepadSessionDir,
} from './context.js';
import { generateMeetingMinutes } from './minutes.js';
import { meetingNotepadPageHtml } from './notepad-page.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { composeLegacyCapture } from '../personal-pads/legacy.js';

export interface MeetingNotepadServerResult {
  ok: boolean;
  mode: 'apply' | 'dry-run' | 'check';
  out: string;
  handoff: string;
  port: number;
  url: string;
  artifact_ref: string;
  scope: ReturnType<typeof createMeetingNotepadContext>['scope'];
  listening: boolean;
}

export const MEETING_NOTEPAD_MAX_BODY_BYTES = 24 * 1024 * 1024;
export const MEETING_NOTEPAD_MAX_CONCURRENT_HEAVY_REQUESTS = 2;
export const MEETING_NOTEPAD_REQUEST_TIMEOUT_MS = 120_000;
export const MEETING_NOTEPAD_HEADERS_TIMEOUT_MS = 10_000;
export const MEETING_NOTEPAD_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const MEETING_NOTEPAD_DEFAULT_PORT = 8148;

export class MeetingNotepadRequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = 'MeetingNotepadRequestBodyTooLargeError';
  }
}

export async function readMeetingNotepadRequestBody(
  source: AsyncIterable<Uint8Array | string>,
  maxBytes = MEETING_NOTEPAD_MAX_BODY_BYTES
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) throw new MeetingNotepadRequestBodyTooLargeError(maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export function validateMeetingNotepadContentLength(
  value?: string,
  maxBytes = MEETING_NOTEPAD_MAX_BODY_BYTES
): number | undefined {
  if (value === undefined) return undefined;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) {
    throw new MeetingNotepadRequestBodyTooLargeError(maxBytes);
  }
  return bytes;
}

export function defaultMeetingNotepadOutputDir(): string {
  return pathResolver.sharedTmp('meeting-notepad');
}

function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (
        arg === '--out' ||
        arg === '--instruction' ||
        arg === '--title' ||
        arg === '--artifact-ref' ||
        arg === '--tier' ||
        arg === '--tenant' ||
        arg === '--organization-id' ||
        arg === '--project-id' ||
        arg === '--mission-id'
      ) {
        i += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

type AttachmentPayload = {
  name?: string;
  mime?: string;
  data_base64?: string;
};

type CapturePayload = {
  title?: string;
  notes?: string;
  transcript?: string;
  instruction?: string;
  language?: string;
  attendees?: string[] | string;
  attachments?: AttachmentPayload[];
};

function sanitizeFileName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || fallback;
}

function extensionForMime(mime: string): string {
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('mp4') || mime.includes('m4a')) return '.m4a';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('markdown') || mime.endsWith('/md')) return '.md';
  if (mime.includes('text')) return '.txt';
  return '';
}

function writeAttachments(
  sessionDir: string,
  attachments: AttachmentPayload[] | undefined
): Array<{ name: string; mime: string; path: string; bytes: number }> {
  const written: Array<{ name: string; mime: string; path: string; bytes: number }> = [];
  const list = Array.isArray(attachments) ? attachments : [];
  const attachDir = path.join(sessionDir, 'attachments');
  safeMkdir(attachDir, { recursive: true });
  list.forEach((att, index) => {
    const b64 = typeof att.data_base64 === 'string' ? att.data_base64.trim() : '';
    if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return;
    const mime =
      typeof att.mime === 'string' && att.mime.trim()
        ? att.mime.trim()
        : 'application/octet-stream';
    const rawName =
      typeof att.name === 'string' && att.name.trim() ? att.name.trim() : `attach-${index + 1}`;
    const hasExt = /\.[a-z0-9]+$/i.test(rawName);
    const fileName = sanitizeFileName(
      hasExt ? rawName : `${rawName}${extensionForMime(mime)}`,
      `attach-${index + 1}${extensionForMime(mime)}`
    );
    const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
    if (buf.byteLength < 1 || buf.byteLength > 12 * 1024 * 1024) return;
    const filePath = path.join(attachDir, `${String(index + 1).padStart(2, '0')}-${fileName}`);
    safeWriteFile(filePath, buf, { mkdir: true });
    written.push({
      name: fileName,
      mime,
      path: portableProtocolServicePathRef(filePath),
      bytes: buf.byteLength,
    });
  });
  return written;
}

function composeSourceText(payload: CapturePayload): string {
  const parts: string[] = [];
  const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
  const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim() : '';
  if (notes) parts.push(`## Notes\n${notes}`);
  if (transcript) parts.push(`## Transcript\n${transcript}`);
  return parts.join('\n\n');
}

function attendeesFrom(payload: CapturePayload): string[] {
  if (Array.isArray(payload.attendees)) {
    return payload.attendees.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof payload.attendees === 'string') {
    return payload.attendees
      .split(/[,\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function lifecyclePrincipal(viewerPrincipal: string): {
  kind: 'nhi' | 'human' | 'service';
  id: string;
} {
  const id = viewerPrincipal.trim();
  if (/^(?:nhi|agent):/u.test(id)) return { kind: 'nhi', id };
  if (/^(?:service|runtime):/u.test(id)) return { kind: 'service', id };
  return { kind: 'human', id };
}

export async function main(
  args: string[] = [],
  options: {
    dryRun?: boolean;
    check?: boolean;
    json?: boolean;
    print?: (value: unknown) => void;
  } = {}
): Promise<MeetingNotepadServerResult | undefined> {
  const positionals = positionalArgs(args);
  const port = Number(positionals[0] || MEETING_NOTEPAD_DEFAULT_PORT);
  const out = option(args, '--out') || defaultMeetingNotepadOutputDir();
  const defaultInstruction = option(args, '--instruction') || '';
  const defaultTitle = option(args, '--title') || '';
  assertProtocolServiceRegistered('meeting-notepad');

  const tier = (option(args, '--tier') || 'personal') as 'public' | 'confidential' | 'personal';
  if (!['public', 'confidential', 'personal'].includes(tier)) {
    throw new ScriptExitError(1, `invalid tier: ${tier}`);
  }
  const serverTenant = getRegisteredEnvText('KYBERION_TENANT')?.trim();
  const cliTenant = option(args, '--tenant')?.trim();
  if (serverTenant && cliTenant && serverTenant !== cliTenant) {
    throw new ScriptExitError(1, 'CLI tenant does not match server-side KYBERION_TENANT scope');
  }
  if (tier !== 'public' && !serverTenant) {
    throw new ScriptExitError(
      1,
      'confidential and personal notepads require server-side KYBERION_TENANT scope'
    );
  }
  const requestedTenant = serverTenant || cliTenant;
  if (requestedTenant?.trim()) {
    // Tenant-bound receipts are only valid for an active tenant profile. The
    // CLI hint is an input selector, never the tenant authority itself.
    resolveTenant(requestedTenant.trim());
  }
  const notepadContext = createMeetingNotepadContext({
    artifact_ref: option(args, '--artifact-ref') || out,
    viewer_principal:
      getRegisteredEnvText('KYBERION_VIEWER_PRINCIPAL') ||
      getRegisteredEnvText('KYBERION_MCP_PRINCIPAL') ||
      'local-noter',
    tier,
    tenant_slug: requestedTenant,
    organization_id: option(args, '--organization-id'),
    project_id: option(args, '--project-id'),
    mission_id: option(args, '--mission-id'),
  });
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ScriptExitError(1, `invalid port: ${port}`);
  }

  const handoff = meetingNotepadHandoffLogicalPath(out);
  const mode = options.check ? 'check' : options.dryRun ? 'dry-run' : 'apply';
  const url = `http://127.0.0.1:${port}/`;
  const preview: MeetingNotepadServerResult = {
    ok: true,
    mode,
    out,
    handoff,
    port,
    url,
    artifact_ref: notepadContext.artifact_ref,
    scope: notepadContext.scope,
    listening: false,
  };
  const print = options.print ?? (() => undefined);
  if (options.dryRun || options.check) {
    print(preview);
    return preview;
  }

  const TOKEN = randomBytes(16).toString('hex');
  let activeHeavyRequests = 0;
  function acquireHeavyRequest(): (() => void) | undefined {
    if (activeHeavyRequests >= MEETING_NOTEPAD_MAX_CONCURRENT_HEAVY_REQUESTS) return undefined;
    activeHeavyRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeHeavyRequests -= 1;
    };
  }

  function rejectIfUnauthorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (req.headers['x-mn-token'] !== TOKEN) {
      res.writeHead(403);
      res.end('bad token');
      req.resume();
      return true;
    }
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)) {
      res.writeHead(403);
      res.end('bad origin');
      req.resume();
      return true;
    }
    try {
      validateMeetingNotepadContentLength(req.headers['content-length']);
    } catch {
      res.writeHead(413);
      res.end('request body too large');
      req.resume();
      return true;
    }
    return false;
  }

  function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  async function persistCapture(
    payload: CapturePayload,
    opts: { generateMinutes: boolean }
  ): Promise<Record<string, unknown>> {
    composeLegacyCapture('meeting-notepad', payload as Record<string, unknown>);
    const sessionId = `${notepadContext.notepad_session_id}-${randomUUID().slice(0, 8)}`;
    const sessionDir = meetingNotepadSessionDir(out, sessionId);
    safeMkdir(sessionDir, { recursive: true });
    const notes = typeof payload.notes === 'string' ? payload.notes : '';
    const transcript = typeof payload.transcript === 'string' ? payload.transcript : '';
    const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
    const title =
      typeof payload.title === 'string' && payload.title.trim()
        ? payload.title.trim()
        : 'Meeting Minutes';
    const language =
      typeof payload.language === 'string' && payload.language.trim()
        ? payload.language.trim()
        : 'ja';
    const sourceText = composeSourceText(payload);
    const notesPath = path.join(sessionDir, 'notes.md');
    const transcriptPath = path.join(sessionDir, 'transcript.md');
    safeWriteFile(notesPath, `# ${title}\n\n${notes.trim() || '_No notes._'}\n`, {
      mkdir: true,
      encoding: 'utf8',
    });
    safeWriteFile(transcriptPath, `${transcript.trim() || ''}\n`, {
      mkdir: true,
      encoding: 'utf8',
    });
    const writtenAttachments = writeAttachments(sessionDir, payload.attachments);
    let minutesPath: string | null = null;
    let minutesJsonPath: string | null = null;
    let minutesMarkdown = '';
    let backend = 'none';
    let artifact: Awaited<ReturnType<typeof generateMeetingMinutes>>['artifact'] | null = null;

    if (opts.generateMinutes) {
      const generated = await generateMeetingMinutes({
        sourceText,
        title,
        language,
        attendees: attendeesFrom(payload),
        attachmentNames: writtenAttachments.map((item) => item.name),
        instruction,
      });
      artifact = generated.artifact;
      backend = generated.backend;
      minutesMarkdown = generated.markdown;
      minutesPath = path.join(sessionDir, 'minutes.md');
      minutesJsonPath = path.join(sessionDir, 'minutes.json');
      safeWriteFile(minutesPath, minutesMarkdown, { mkdir: true, encoding: 'utf8' });
      safeWriteFile(
        minutesJsonPath,
        JSON.stringify(
          {
            title: artifact.title,
            summary: artifact.summary,
            decisions: artifact.decisions,
            action_items: artifact.action_items,
            open_questions: artifact.open_questions,
            backend,
            generated_at: nowIso(),
          },
          null,
          2
        ),
        { mkdir: true, encoding: 'utf8' }
      );
    }

    const handoffBody = {
      kind: 'meeting-notepad-handoff',
      version: 1,
      notepad_session_id: notepadContext.notepad_session_id,
      capture_session_id: sessionId,
      artifact_ref: portableProtocolServicePathRef(notepadContext.artifact_ref),
      viewer_principal: notepadContext.viewer_principal,
      scope: notepadContext.scope,
      exported_at: nowIso(),
      title,
      language,
      notes_path: portableProtocolServicePathRef(notesPath),
      transcript_path: portableProtocolServicePathRef(transcriptPath),
      minutes_path: minutesPath ? portableProtocolServicePathRef(minutesPath) : null,
      minutes_json_path: minutesJsonPath ? portableProtocolServicePathRef(minutesJsonPath) : null,
      attachments: writtenAttachments,
      instruction,
      processing: {
        auto_start_mission: false,
        note: 'Pick up notes/transcript/minutes/attachments + instruction and run meeting-followup or a Kyberion mission.',
      },
    };
    const sessionHandoff = path.join(sessionDir, 'handoff.json');
    safeWriteFile(sessionHandoff, JSON.stringify(handoffBody, null, 2), {
      mkdir: true,
      encoding: 'utf8',
    });
    safeWriteFile(handoff, JSON.stringify(handoffBody, null, 2), {
      mkdir: true,
      encoding: 'utf8',
    });
    safeWriteFile(
      meetingNotepadReceiptLogicalPath(notepadContext),
      JSON.stringify(
        {
          notepad_session_id: notepadContext.notepad_session_id,
          capture_session_id: sessionId,
          artifact_ref: portableProtocolServicePathRef(notepadContext.artifact_ref),
          viewer_principal: notepadContext.viewer_principal,
          scope: notepadContext.scope,
          exported_at: nowIso(),
          session_dir: portableProtocolServicePathRef(sessionDir),
          handoff_path: portableProtocolServicePathRef(handoff),
          minutes_path: minutesPath ? portableProtocolServicePathRef(minutesPath) : null,
          attachment_count: writtenAttachments.length,
          instruction_chars: instruction.length,
          notes_chars: notes.length,
          transcript_chars: transcript.length,
        },
        null,
        2
      ),
      { mkdir: true, encoding: 'utf8' }
    );

    return {
      ok: true,
      capture_session_id: sessionId,
      session_dir: portableProtocolServicePathRef(sessionDir),
      handoff_path: portableProtocolServicePathRef(handoff),
      notes_path: portableProtocolServicePathRef(notesPath),
      transcript_path: portableProtocolServicePathRef(transcriptPath),
      minutes_path: minutesPath ? portableProtocolServicePathRef(minutesPath) : null,
      minutes_json_path: minutesJsonPath ? portableProtocolServicePathRef(minutesJsonPath) : null,
      minutes_markdown: minutesMarkdown,
      minutes_preview: minutesMarkdown.slice(0, 2000),
      backend,
      attachments: writtenAttachments,
    };
  }

  const server = http.createServer((req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another meeting-notepad request is already in progress');
          return;
        }
        res.once('finish', release);
        res.once('close', release);
        const html = meetingNotepadPageHtml({
          token: TOKEN,
          exportUrl: '/export',
          minutesUrl: '/minutes',
          transcribeUrl: '/transcribe',
          defaultInstruction,
          defaultTitle,
          outLabel: out,
        });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      if (
        req.method === 'POST' &&
        (req.url === '/export' || req.url === '/minutes' || req.url === '/transcribe')
      ) {
        if (rejectIfUnauthorized(req, res)) return;
        const release = acquireHeavyRequest();
        if (!release) {
          res.writeHead(503, { 'Retry-After': '1' });
          res.end('another meeting-notepad request is already in progress');
          req.resume();
          return;
        }
        req.once('aborted', release);
        const route = req.url;
        void (async () => {
          try {
            const raw = await readMeetingNotepadRequestBody(req, MEETING_NOTEPAD_MAX_BODY_BYTES);
            let payload: CapturePayload & {
              audio_base64?: string;
              mime?: string;
            };
            try {
              payload = JSON.parse(raw) as typeof payload;
            } catch {
              jsonResponse(res, 400, { ok: false, error: 'invalid json' });
              return;
            }

            if (route === '/transcribe') {
              const b64 =
                typeof payload.audio_base64 === 'string' ? payload.audio_base64.trim() : '';
              if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
                jsonResponse(res, 400, { ok: false, error: 'audio_base64 required' });
                return;
              }
              const mime =
                typeof payload.mime === 'string' && payload.mime.trim()
                  ? payload.mime.trim()
                  : 'audio/webm';
              const audioBuf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
              if (audioBuf.byteLength < 32) {
                jsonResponse(res, 400, { ok: false, error: 'audio too small' });
                return;
              }
              const audioDir = path.join(out, 'audio');
              safeMkdir(audioDir, { recursive: true });
              const audioPath = path.join(
                audioDir,
                `${nowIso().replace(/[:.]/g, '-')}${extensionForMime(mime) || '.webm'}`
              );
              safeWriteFile(audioPath, audioBuf, { mkdir: true });
              const language =
                typeof payload.language === 'string' && payload.language.trim()
                  ? payload.language.trim()
                  : 'ja';
              try {
                const bridge = getSpeechToTextBridge();
                const result = await bridge.transcribe({
                  audioPath,
                  language,
                });
                jsonResponse(res, 200, {
                  ok: true,
                  text: result.text || '',
                  backend: result.backend,
                  audio_path: portableProtocolServicePathRef(audioPath),
                  synthetic: Boolean(result.synthetic),
                });
              } catch (error) {
                jsonResponse(res, 200, {
                  ok: true,
                  text: '',
                  backend: 'unavailable',
                  audio_path: portableProtocolServicePathRef(audioPath),
                  warning: error instanceof Error ? error.message : String(error),
                });
              }
              return;
            }

            const result = await persistCapture(payload, {
              generateMinutes: route === '/minutes',
            });
            jsonResponse(res, route === '/minutes' ? 201 : 200, result);
            print(
              `[${route.slice(1)}] wrote ${String(result.session_dir)} handoff=${String(result.handoff_path)}`
            );
          } catch (e: unknown) {
            if (e instanceof MeetingNotepadRequestBodyTooLargeError) {
              if (!res.headersSent) {
                res.writeHead(413);
                res.end('request body too large');
              }
              req.resume();
            } else if (!res.headersSent) {
              jsonResponse(res, 500, {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              });
            }
            print(`[meeting-notepad] ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            release();
          }
        })();
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e: unknown) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(e instanceof Error ? e.message : String(e));
      }
    }
  });
  server.requestTimeout = MEETING_NOTEPAD_REQUEST_TIMEOUT_MS;
  server.headersTimeout = MEETING_NOTEPAD_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = MEETING_NOTEPAD_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 100;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) =>
      reject(new ScriptExitError(1, `[meeting-notepad] failed to listen: ${error.message}`));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      try {
        recordProtocolServiceLifecycle({
          serviceId: 'meeting-notepad',
          action: 'start',
          status: 'started',
          scope: notepadContext.scope,
          actorRole: 'surface_runtime',
          principal: lifecyclePrincipal(notepadContext.viewer_principal),
          requestedBy: notepadContext.viewer_principal,
          correlationId: notepadContext.notepad_session_id,
          metadata: {
            port,
            artifact_ref: portableProtocolServicePathRef(notepadContext.artifact_ref),
            out: portableProtocolServicePathRef(out),
          },
        });
      } catch (error) {
        server.close(() => undefined);
        reject(
          new ScriptExitError(1, `[meeting-notepad] start lifecycle receipt unavailable: ${error}`)
        );
        return;
      }
      if (options.json) {
        print({ ...preview, listening: true });
      } else {
        print(`Meeting notepad server → ${url}`);
        print(`  out    : ${out}`);
        print(`  handoff: ${handoff}`);
        print(`  artifact: ${notepadContext.artifact_ref}`);
        print(
          `  scope  : ${notepadContext.scope.scope_kind}/${notepadContext.scope.tenant_slug || 'system'}`
        );
        print(`  token  : ${TOKEN.slice(0, 6)}…  (127.0.0.1 only)`);
        print(`  ${catalogT('meeting_notepad:server_usage_hint')}`);
      }
      resolve();
    });
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    try {
      recordProtocolServiceLifecycle({
        serviceId: 'meeting-notepad',
        action: 'stop',
        status: 'stopped',
        scope: notepadContext.scope,
        actorRole: 'surface_runtime',
        principal: lifecyclePrincipal(notepadContext.viewer_principal),
        requestedBy: notepadContext.viewer_principal,
        correlationId: notepadContext.notepad_session_id,
      });
    } catch (error) {
      print(`[meeting-notepad] stop lifecycle receipt unavailable: ${error}`);
    } finally {
      server.close();
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...preview, listening: true };
}

export const runMeetingNotepadServer = defineScript({
  name: 'meeting-notepad:server',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, print }) => main(argv, { dryRun, check, json, print }),
});

if (isDirectScript(import.meta.url, 'server.ts') || isDirectScript(import.meta.url, 'server.js')) {
  void runMeetingNotepadServer();
}
