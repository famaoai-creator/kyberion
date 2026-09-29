import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { inferDocumentFormat, readDocument } from '../media/document-reader.js';
import { safeReadFile, safeWriteFile } from '../secure-io.js';
import {
  appendDiscussionEvent,
  DiscussionUserError,
  readDiscussionRoom,
  sanitizeDiscussionId,
} from './discussion-store.js';
import type { DiscussionAttachmentView } from './discussion-types.js';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_ROOM = 24;
const EXCERPT_CHARS = 6000;

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
  '.log',
  '.yaml',
  '.yml',
]);
/** Images are kept (and shown) but not read; SVG is excluded because it can carry script. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** The type we serve a file as is decided by its extension, never by what the uploader claimed. */
export function attachmentContentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_TYPES[ext]) return IMAGE_TYPES[ext];
  if (ext === '.pdf') return 'application/pdf';
  return TEXT_EXTENSIONS.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}

export function isInlineAttachment(name: string): boolean {
  return Boolean(IMAGE_TYPES[path.extname(name).toLowerCase()]);
}

function isAllowed(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return (
    TEXT_EXTENSIONS.has(ext) || Boolean(IMAGE_TYPES[ext]) || Boolean(inferDocumentFormat(name))
  );
}

function safeName(raw: string): string {
  const base = path
    .basename(raw.replace(/\\/gu, '/'))
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .trim();
  return (base || 'file').slice(0, 80);
}

async function extractExcerpt(name: string, bytes: Buffer): Promise<string | undefined> {
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return bytes.toString('utf8').slice(0, EXCERPT_CHARS);
  const format = inferDocumentFormat(name);
  if (!format) return undefined;
  try {
    const result = await readDocument(bytes, format);
    return result.markdown.slice(0, EXCERPT_CHARS) || undefined;
  } catch {
    return undefined; // kept as an attachment even when it cannot be read
  }
}

export async function addDiscussionAttachment(
  roomId: string,
  actor: string,
  file: { name: string; bytes: Buffer }
): Promise<DiscussionAttachmentView> {
  const id = sanitizeDiscussionId(roomId);
  const room = readDiscussionRoom(id);
  if (!room) throw new DiscussionUserError('discussion not found');
  if (room.attachments.length >= MAX_ATTACHMENTS_PER_ROOM) {
    throw new DiscussionUserError('This conversation has too many attachments');
  }
  const name = safeName(file.name);
  if (!isAllowed(name)) throw new DiscussionUserError(`This file type is not supported: ${name}`);
  if (file.bytes.length === 0) throw new DiscussionUserError('The file is empty');
  if (file.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new DiscussionUserError(
      `The file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`
    );
  }
  const attachmentId = `att-${randomUUID().slice(0, 8)}`;
  const logicalPath = `active/shared/runtime/discussions/${id}/attachments/${attachmentId}-${name}`;
  safeWriteFile(pathResolver.rootResolve(logicalPath), file.bytes);
  const excerpt = await extractExcerpt(name, file.bytes);
  appendDiscussionEvent(id, {
    type: 'attachment_added',
    id: attachmentId,
    name,
    mime: attachmentContentType(name),
    size: file.bytes.length,
    path: logicalPath,
    status: excerpt ? 'read' : 'stored',
    ...(excerpt ? { excerpt } : {}),
    actor,
  });
  const added = readDiscussionRoom(id)?.attachments.find((a) => a.id === attachmentId);
  if (!added) throw new Error('attachment was not recorded');
  return added;
}

export function readDiscussionAttachment(
  roomId: string,
  attachmentId: string
): { name: string; bytes: Buffer } | null {
  const room = readDiscussionRoom(roomId);
  const attachment = room?.attachments.find((a) => a.id === attachmentId);
  if (!attachment) return null;
  const bytes = safeReadFile(pathResolver.rootResolve(attachment.path)) as Buffer;
  return { name: attachment.name, bytes };
}
