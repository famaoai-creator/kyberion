import { randomUUID, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import {
  inferIMessageGroup,
  normalizeIMessageAttachments,
  normalizeIMessageTapback,
  type IMessageStimulus,
} from './imessage-utils.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeUnlinkSync,
  safeWriteFile,
  validateFileSize,
} from './secure-io.js';

const MAX_BLUEBUBBLES_ATTACHMENT_SIZE_MB = 100;
const MAX_BLUEBUBBLES_ATTACHMENT_BYTES = MAX_BLUEBUBBLES_ATTACHMENT_SIZE_MB * 1024 * 1024;
const BLUEBUBBLES_ATTACHMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BLUEBUBBLES_ATTACHMENT_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const BLUEBUBBLES_TEXT_TIMEOUT_MS = 30_000;
const BLUEBUBBLES_ATTACHMENT_TIMEOUT_MS = 120_000;

export interface BlueBubblesConfig {
  baseUrl: string;
  password: string;
  sendMethod: 'private-api' | 'imessage';
  webhookSecret?: string;
}

export interface BlueBubblesConfigurationReport {
  configured: boolean;
  valid: boolean;
  detail: 'not_configured' | 'configured' | 'invalid_base_url' | 'missing_password';
  baseUrl?: string;
  capabilities: {
    send_text: boolean;
    receive_webhooks: boolean;
    group_target: boolean;
    send_attachments: boolean;
    receive_attachments: boolean;
    typing_events: boolean;
    read_status_events: boolean;
  };
}

export interface BlueBubblesTextRequest {
  chatGuid: string;
  text: string;
  sendMethod?: BlueBubblesConfig['sendMethod'];
}

export interface BlueBubblesTextResult {
  sent: true;
  platform: 'imessage';
  chatGuid: string;
  text: string;
  detail: string;
}

export interface BlueBubblesAttachmentRequest {
  chatGuid: string;
  filePath: string;
  message?: string;
  filename?: string;
}

export interface BlueBubblesAttachmentResult {
  sent: true;
  platform: 'imessage';
  chatGuid: string;
  filename: string;
  detail: string;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`BlueBubbles request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Compare the bridge-owned webhook secret without leaking length or contents. */
export function verifyBlueBubblesWebhookSecret(
  expectedSecret: string | undefined,
  providedSecret: string | undefined
): boolean {
  const expected = Buffer.from(String(expectedSecret || ''), 'utf8');
  const provided = Buffer.from(String(providedSecret || ''), 'utf8');
  if (expected.length === 0 || expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function normalizeBaseUrl(value: string): string | null {
  const raw = value.trim().replace(/\/+$/u, '');
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.toString().replace(/\/+$/u, '');
  } catch {
    return null;
  }
}

/** Resolve BlueBubbles settings without ever returning the password. */
export function resolveBlueBubblesConfig(
  env: Record<string, string | undefined> = process.env
): BlueBubblesConfig | null {
  const baseUrl = normalizeBaseUrl(String(env.KYBERION_BLUEBUBBLES_URL || ''));
  const password = String(env.KYBERION_BLUEBUBBLES_PASSWORD || '').trim();
  if (!baseUrl || !password) return null;
  const rawMethod = String(env.KYBERION_BLUEBUBBLES_SEND_METHOD || 'private-api')
    .trim()
    .toLowerCase();
  const sendMethod: BlueBubblesConfig['sendMethod'] =
    rawMethod === 'imessage' ? 'imessage' : 'private-api';
  const webhookSecret = String(env.KYBERION_BLUEBUBBLES_WEBHOOK_SECRET || '').trim();
  return {
    baseUrl,
    password,
    sendMethod,
    ...(webhookSecret ? { webhookSecret } : {}),
  };
}

/** Report the locally available adapter contract without contacting a server. */
export function evaluateBlueBubblesConfiguration(
  env: Record<string, string | undefined> = process.env
): BlueBubblesConfigurationReport {
  const rawUrl = String(env.KYBERION_BLUEBUBBLES_URL || '').trim();
  const password = String(env.KYBERION_BLUEBUBBLES_PASSWORD || '').trim();
  const baseUrl = normalizeBaseUrl(rawUrl);
  if (!rawUrl && !password) {
    return {
      configured: false,
      valid: false,
      detail: 'not_configured',
      capabilities: {
        send_text: false,
        receive_webhooks: false,
        group_target: false,
        send_attachments: false,
        receive_attachments: false,
        typing_events: false,
        read_status_events: false,
      },
    };
  }
  if (!baseUrl) {
    return {
      configured: true,
      valid: false,
      detail: 'invalid_base_url',
      capabilities: {
        send_text: false,
        receive_webhooks: false,
        group_target: false,
        send_attachments: false,
        receive_attachments: false,
        typing_events: false,
        read_status_events: false,
      },
    };
  }
  if (!password) {
    return {
      configured: true,
      valid: false,
      detail: 'missing_password',
      baseUrl,
      capabilities: {
        send_text: false,
        receive_webhooks: false,
        group_target: false,
        send_attachments: false,
        receive_attachments: false,
        typing_events: false,
        read_status_events: false,
      },
    };
  }
  return {
    configured: true,
    valid: true,
    detail: 'configured',
    baseUrl,
    capabilities: {
      send_text: true,
      receive_webhooks: Boolean(String(env.KYBERION_BLUEBUBBLES_WEBHOOK_SECRET || '').trim()),
      group_target: true,
      // The documented multipart send endpoint requires the Private API;
      // inbound binary download remains disabled until its bounded contract
      // is verified against the installed server.
      send_attachments:
        String(env.KYBERION_BLUEBUBBLES_SEND_METHOD || 'private-api')
          .trim()
          .toLowerCase() !== 'imessage',
      receive_attachments: true,
      typing_events: true,
      read_status_events: true,
    },
  };
}

export function buildBlueBubblesTextRequest(
  config: BlueBubblesConfig,
  request: BlueBubblesTextRequest
): { url: string; init: RequestInit } {
  const chatGuid = request.chatGuid.trim();
  const text = request.text.trim();
  if (!chatGuid) throw new Error('BlueBubbles chatGuid is required');
  if (!text) throw new Error('BlueBubbles text is required');
  const url = new URL('/api/v1/message/text', `${config.baseUrl}/`);
  url.searchParams.set('password', config.password);
  return {
    url: url.toString(),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatGuid,
        text,
        method: request.sendMethod || config.sendMethod,
      }),
    },
  };
}

/** Send text through an injected fetch implementation; tests never need a live server. */
export async function sendBlueBubblesText(
  config: BlueBubblesConfig,
  request: BlueBubblesTextRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = BLUEBUBBLES_TEXT_TIMEOUT_MS
): Promise<BlueBubblesTextResult> {
  const built = buildBlueBubblesTextRequest(config, request);
  const response = await fetchWithTimeout(fetchImpl, built.url, built.init, timeoutMs);
  if (!response.ok) {
    throw new Error(`BlueBubbles request failed with HTTP ${response.status}`);
  }
  return {
    sent: true,
    platform: 'imessage',
    chatGuid: request.chatGuid.trim(),
    text: request.text.trim(),
    detail: 'sent via BlueBubbles text API',
  };
}

/**
 * Send one local file through BlueBubbles' documented multipart endpoint.
 *
 * Attachments are deliberately limited to the Private API mode. The inbound
 * webhook may expose attachment metadata, but downloading arbitrary binary
 * payloads is a separate contract and remains disabled.
 */
export async function sendBlueBubblesAttachment(
  config: BlueBubblesConfig,
  request: BlueBubblesAttachmentRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = BLUEBUBBLES_ATTACHMENT_TIMEOUT_MS
): Promise<BlueBubblesAttachmentResult> {
  if (config.sendMethod !== 'private-api') {
    throw new Error('BlueBubbles attachment sending requires the private-api method');
  }
  const chatGuid = request.chatGuid.trim();
  if (!chatGuid) throw new Error('BlueBubbles chatGuid is required');

  const resolved = pathResolver.resolve(request.filePath);
  if (!safeExistsSync(resolved)) {
    throw new Error(`BlueBubbles attachment not found: ${request.filePath}`);
  }
  validateFileSize(resolved, MAX_BLUEBUBBLES_ATTACHMENT_SIZE_MB);
  const bytes = safeReadFile(resolved, {
    encoding: null,
    maxSizeMB: MAX_BLUEBUBBLES_ATTACHMENT_SIZE_MB,
  }) as Buffer;
  const filename = path.basename(String(request.filename || resolved).trim()) || 'attachment';

  const form = new FormData();
  form.set('chatGuid', chatGuid);
  form.set('tempGuid', randomUUID());
  form.set('message', String(request.message || '').trim());
  form.set('name', filename);
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  form.append(
    'attachment',
    new Blob([blobBytes.buffer as ArrayBuffer], { type: 'application/octet-stream' }),
    filename
  );

  const url = new URL('/api/v1/message/attachment', `${config.baseUrl}/`);
  url.searchParams.set('password', config.password);
  const response = await fetchWithTimeout(
    fetchImpl,
    url.toString(),
    {
      method: 'POST',
      body: form,
    },
    timeoutMs
  );
  if (!response.ok) {
    throw new Error(`BlueBubbles attachment request failed with HTTP ${response.status}`);
  }
  return {
    sent: true,
    platform: 'imessage',
    chatGuid,
    filename,
    detail: 'sent via BlueBubbles attachment API',
  };
}

export interface BlueBubblesAttachmentDownloadRequest {
  attachmentGuid: string;
  storageKey: string;
  filename?: string;
  mimeType?: string;
  maxBytes?: number;
}

export interface BlueBubblesAttachmentDownloadResult {
  downloaded: true;
  attachmentGuid: string;
  filePath: string;
  filename: string;
  mimeType?: string;
  size: number;
}

export interface BlueBubblesAttachmentCachePruneOptions {
  ttlMs?: number;
  maxBytes?: number;
  dryRun?: boolean;
}

export interface BlueBubblesAttachmentCachePruneResult {
  scanned: string[];
  expired: string[];
  deleted: string[];
  bytesBefore: number;
  bytesAfter: number;
}

const BLUEBUBBLES_ATTACHMENT_CACHE_DIR = 'active/shared/tmp/bluebubbles-attachments';

function collectBlueBubblesAttachmentFiles(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  const files: string[] = [];
  for (const name of safeReaddir(dir)) {
    const filePath = path.join(dir, name);
    try {
      const stat = safeLstat(filePath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) files.push(...collectBlueBubblesAttachmentFiles(filePath));
      else files.push(filePath);
    } catch {
      // A concurrently removed or unreadable cache entry is harmless.
    }
  }
  return files;
}

/** Keep the inbound attachment cache bounded independently of the global janitor. */
export function pruneBlueBubblesAttachmentCache(
  options: BlueBubblesAttachmentCachePruneOptions = {}
): BlueBubblesAttachmentCachePruneResult {
  const ttlMs = options.ttlMs ?? BLUEBUBBLES_ATTACHMENT_CACHE_TTL_MS;
  const maxBytes = options.maxBytes ?? BLUEBUBBLES_ATTACHMENT_CACHE_MAX_BYTES;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new Error('BlueBubbles cache ttlMs is invalid');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('BlueBubbles cache maxBytes is invalid');
  }

  const files = collectBlueBubblesAttachmentFiles(
    pathResolver.resolve(BLUEBUBBLES_ATTACHMENT_CACHE_DIR)
  );
  const now = Date.now();
  const entries = files.flatMap((filePath) => {
    try {
      const stat = safeStat(filePath);
      return [{ filePath, size: stat.size, mtimeMs: stat.mtimeMs }];
    } catch {
      return [];
    }
  });
  const expired = entries
    .filter((entry) => now - entry.mtimeMs > ttlMs)
    .map((entry) => entry.filePath);
  const expiredSet = new Set(expired);
  const remaining = entries
    .filter((entry) => !expiredSet.has(entry.filePath))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.filePath.localeCompare(b.filePath));
  const bytesBefore = entries.reduce((total, entry) => total + entry.size, 0);
  let bytesAfterExpiry =
    bytesBefore -
    entries
      .filter((entry) => expiredSet.has(entry.filePath))
      .reduce((total, entry) => total + entry.size, 0);
  const toDelete = new Set(expired);
  for (const entry of remaining) {
    if (bytesAfterExpiry <= maxBytes) break;
    toDelete.add(entry.filePath);
    bytesAfterExpiry -= entry.size;
  }

  const deleted: string[] = [];
  if (!options.dryRun) {
    for (const filePath of toDelete) {
      try {
        safeUnlinkSync(filePath);
        deleted.push(filePath);
      } catch {
        // The next janitor/download pass can retry an entry that disappears here.
      }
    }
  }
  const bytesDeleted = entries
    .filter((entry) => deleted.includes(entry.filePath))
    .reduce((total, entry) => total + entry.size, 0);
  return {
    scanned: files,
    expired,
    deleted,
    bytesBefore,
    bytesAfter: options.dryRun ? bytesAfterExpiry : Math.max(0, bytesBefore - bytesDeleted),
  };
}

function safeAttachmentSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || normalized.includes('\u0000')) {
    throw new Error(`BlueBubbles ${label} is invalid`);
  }
  return normalized.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 160) || 'attachment';
}

function safeAttachmentFilename(value: string | undefined, attachmentGuid: string): string {
  const basename = path.basename(String(value || '').trim());
  const normalized = basename.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 160);
  return normalized || `attachment-${safeAttachmentSegment(attachmentGuid, 'attachment GUID')}.bin`;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`BlueBubbles attachment exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`BlueBubbles attachment exceeds the ${maxBytes}-byte limit`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new Error(`BlueBubbles attachment exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total
  );
}

/** Download one webhook attachment into governed temporary storage. */
export async function downloadBlueBubblesAttachment(
  config: BlueBubblesConfig,
  request: BlueBubblesAttachmentDownloadRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = BLUEBUBBLES_ATTACHMENT_TIMEOUT_MS
): Promise<BlueBubblesAttachmentDownloadResult> {
  const attachmentGuid = request.attachmentGuid.trim();
  const storageKey = safeAttachmentSegment(request.storageKey, 'attachment storage key');
  const guidSegment = safeAttachmentSegment(attachmentGuid, 'attachment GUID');
  if (!attachmentGuid) throw new Error('BlueBubbles attachment GUID is required');
  const maxBytes = request.maxBytes ?? MAX_BLUEBUBBLES_ATTACHMENT_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_BLUEBUBBLES_ATTACHMENT_BYTES
  ) {
    throw new Error('BlueBubbles attachment maxBytes is invalid');
  }

  const url = new URL(
    `/api/v1/attachment/${encodeURIComponent(attachmentGuid)}/download`,
    `${config.baseUrl}/`
  );
  url.searchParams.set('password', config.password);
  const response = await fetchWithTimeout(
    fetchImpl,
    url.toString(),
    { method: 'GET', headers: { accept: request.mimeType || '*/*' } },
    timeoutMs
  );
  if (!response.ok) {
    throw new Error(`BlueBubbles attachment download failed with HTTP ${response.status}`);
  }
  const bytes = await readBoundedResponse(response, maxBytes);
  const filename = safeAttachmentFilename(request.filename, attachmentGuid);
  const storedFilename = `${guidSegment}-${filename}`;
  const logicalDir = `active/shared/tmp/bluebubbles-attachments/${storageKey}`;
  const logicalPath = `${logicalDir}/${storedFilename}`;
  safeMkdir(logicalDir, { recursive: true });
  safeWriteFile(logicalPath, bytes);
  pruneBlueBubblesAttachmentCache();
  return {
    downloaded: true,
    attachmentGuid,
    filePath: pathResolver.resolve(logicalPath),
    filename,
    ...(response.headers.get('content-type') || request.mimeType
      ? { mimeType: response.headers.get('content-type') || request.mimeType }
      : {}),
    size: bytes.byteLength,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Normalize a BlueBubbles new-message webhook into the existing iMessage stimulus contract. */
export function parseBlueBubblesWebhook(payload: unknown): IMessageStimulus | null {
  const root = asRecord(payload);
  if (root?.type !== 'new-message') return null;
  const data = asRecord(root.data);
  if (!data || data.isFromMe === true) return null;
  const chats = Array.isArray(data.chats) ? data.chats : [];
  const chat = asRecord(chats[0]);
  const chatGuid = String(chat?.guid || chat?.chatGuid || '').trim();
  if (!chatGuid) return null;
  const id = String(data.guid || data.id || data.dateCreated || '').trim();
  if (!id) return null;
  const sender = String(data.handle || data.sender || data.senderAddress || 'unknown').trim();
  const text = String(data.text || '').trim();
  const tapback = normalizeIMessageTapback(
    data.associatedMessageType ?? data.associated_message_type,
    data.associatedMessageGuid ?? data.associated_message_guid
  );
  return {
    id,
    sender: sender || 'unknown',
    text,
    date: String(data.dateCreated || data.date || new Date().toISOString()),
    isFromMe: false,
    chatId: chatGuid,
    chatGuid,
    isGroup: inferIMessageGroup(chat || {}),
    attachments: normalizeIMessageAttachments(data.attachments ?? data.attachment),
    ...(tapback ? { tapback } : {}),
  };
}
