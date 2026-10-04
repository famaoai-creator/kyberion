import { logger } from '@agent/core/core';
import { isRecord, parseSafeJsonInput } from '@agent/core/foundation';
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeUnlinkSync,
  safeMoveSync,
  safeExec,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '@agent/core/seam';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * A2A Physical Transport Layer v1.0
 * Handles physical delivery and encryption of A2A Envelopes.
 */

const A2A_INBOX = pathResolver.rootResolve('active/shared/runtime/a2a/inbox');
const A2A_OUTBOX = pathResolver.rootResolve('active/shared/runtime/a2a/outbox');
const A2A_QUARANTINE = path.join(A2A_INBOX, '.quarantine');

export interface A2ATransportOptions {
  /** Encrypt the envelope before it reaches the physical transport. */
  encrypt: boolean;
  /** Repository-trusted public key reference used by the common encoder. */
  target_public_key?: string;
}

export interface A2ATransportPacket {
  message_id: string;
  payload: string;
  encrypted: boolean;
}

export interface A2ATransport {
  /** Receives only the serialized wire payload, already encrypted when requested. */
  send(packet: A2ATransportPacket): Promise<void>;
  poll(): Promise<A2AInboxMessage[]>;
}

const a2aTransportSeam = createSeam<A2ATransport>({
  key: 'a2a-transport',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

/** Register a named physical A2A transport. */
export function registerA2ATransport(
  method: string,
  transport: A2ATransport,
  metadata: SeamProviderMetadata = {
    provenance: 'plugin',
    source: 'network-a2a-transport-extension',
  }
): () => void {
  const id = method.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]*$/.test(id)) {
    throw new Error(`[A2A_Transport] invalid transport method: ${method}`);
  }
  if (id === 'local') {
    throw new Error('[A2A_Transport] local is reserved for the built-in transport');
  }
  if (!transport || typeof transport.send !== 'function' || typeof transport.poll !== 'function') {
    throw new Error(`[A2A_Transport] '${id}' must implement send() and poll()`);
  }
  return a2aTransportSeam.register(id, transport, metadata);
}

export function listA2ATransportMethods(): string[] {
  return [
    'local',
    ...a2aTransportSeam
      .list()
      .map((provider) => provider.id)
      .sort(),
  ];
}

function resolveA2ATransport(method: string): A2ATransport {
  const id = method.trim().toLowerCase();
  if (id === 'local') return localA2ATransport;
  const matches = a2aTransportSeam
    .list()
    .filter((provider) => provider.id.trim().toLowerCase() === id);
  if (matches.length === 0) {
    throw new Error(`[A2A_Transport] unsupported transport method: ${method}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `[A2A_Transport] transport method ${method} is ambiguous across: ${matches.map((provider) => provider.id).join(', ')}`
    );
  }
  const transport: unknown = matches[0]?.implementation;
  if (
    !isRecord(transport) ||
    typeof transport.send !== 'function' ||
    typeof transport.poll !== 'function'
  ) {
    throw new Error(
      `[A2A_Transport] registered transport ${matches[0]?.id} must implement send() and poll()`
    );
  }
  return transport as unknown as A2ATransport;
}

export interface A2AEnvelope {
  header: { msg_id: string } & Record<string, unknown>;
  [key: string]: unknown;
}

export interface A2AInboxMessage {
  header: { msg_id: string } & Record<string, unknown>;
  [key: string]: unknown;
}

export function parseA2AInboxMessage(value: unknown): A2AInboxMessage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.header === null || typeof record.header !== 'object' || Array.isArray(record.header)) {
    return undefined;
  }
  const header = record.header as Record<string, unknown>;
  if (typeof header.msg_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(header.msg_id)) {
    return undefined;
  }
  if (record.body === undefined && record.payload === undefined) return undefined;
  return { ...record, header: { ...header, msg_id: header.msg_id } };
}

export function parseA2ASecretValue(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[A2A_Transport] secret actuator response must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.status !== 'success' || typeof record.v !== 'string') {
    throw new Error('[A2A_Transport] secret actuator did not return the A2A passphrase');
  }
  return record.v;
}

/**
 * Sends an A2A message to the physical transport layer.
 */
export async function sendA2AMessage(
  message: unknown,
  options: A2ATransportOptions & { method?: string }
) {
  if (
    !isRecord(message) ||
    !isRecord(message.header) ||
    typeof message.header.msg_id !== 'string'
  ) {
    throw new Error('[A2A_Transport] message must contain a valid header.msg_id');
  }
  const envelope = message as unknown as A2AEnvelope;
  const messageId = envelope.header.msg_id;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(messageId)) {
    throw new Error(`[A2A_Transport] invalid message id: ${String(messageId)}`);
  }
  if (options.encrypt && !options.target_public_key?.trim()) {
    throw new Error('[A2A_Transport] encryption requested but target_public_key is missing');
  }
  let payload = JSON.stringify(envelope);
  if (options.encrypt) {
    logger.info(`🔒 [A2A_Transport] Encrypting message ${messageId}...`);
    payload = await _encryptPayload(payload, options.target_public_key!);
  }
  const { method = 'local' } = options;
  await resolveA2ATransport(method).send({
    message_id: messageId,
    payload,
    encrypted: options.encrypt,
  });
}

const localA2ATransport: A2ATransport = {
  async send(packet) {
    if (!safeExistsSync(A2A_OUTBOX)) safeMkdir(A2A_OUTBOX, { recursive: true });
    const outPath = assertSafeRepositoryPath(path.join(A2A_OUTBOX, `${packet.message_id}.a2a`), {
      allowMissingLeaf: true,
    });
    safeWriteFile(outPath, packet.payload);
    logger.success(`📥 [A2A_Transport] Message ${packet.message_id} placed in local outbox.`);
  },
  poll: pollLocalA2AInbox,
};

/**
 * Checks for new A2A messages in the physical inbox.
 */
export async function pollA2AInbox(method = 'local'): Promise<A2AInboxMessage[]> {
  const messages = await resolveA2ATransport(method).poll();
  if (!Array.isArray(messages)) {
    throw new Error('[A2A_Transport] transport ' + method + ' poll() must return an array');
  }
  return messages.map((message, index) => {
    const serialized = JSON.stringify(message);
    if (typeof serialized !== 'string') {
      throw new Error(
        '[A2A_Transport] transport ' +
          method +
          ' returned a non-serializable message at index ' +
          index
      );
    }
    const safeMessage = parseSafeJsonInput(
      serialized,
      '[A2A_Transport] transport ' + method + ' message[' + index + ']'
    );
    const parsed = parseA2AInboxMessage(safeMessage);
    if (!parsed) {
      throw new Error(
        '[A2A_Transport] transport ' + method + ' returned an invalid A2A message at index ' + index
      );
    }
    return parsed;
  });
}

async function pollLocalA2AInbox(): Promise<A2AInboxMessage[]> {
  if (!safeExistsSync(A2A_INBOX)) return [];

  const files = safeReaddir(A2A_INBOX).filter((f) => f.endsWith('.a2a'));
  const messages: A2AInboxMessage[] = [];

  for (const file of files) {
    let filePath: string;
    try {
      filePath = assertSafeRepositoryPath(path.join(A2A_INBOX, file));
    } catch {
      logger.warn(`[A2A_Transport] skipped unsafe inbox entry: ${file}`);
      continue;
    }
    if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
      logger.warn(`[A2A_Transport] skipped non-regular inbox entry: ${file}`);
      continue;
    }
    let content = safeReadFile(filePath, { encoding: 'utf8' }) as string;

    if (content.startsWith('---ENCRYPTED---')) {
      logger.info(`🔓 [A2A_Transport] Decrypting message ${file}...`);
      content = await _decryptPayload(content);
    }

    try {
      const message = parseA2AInboxMessage(
        parseSafeJsonInput(content, `[A2A_Transport] inbox message ${file}`)
      );
      if (!message) throw new Error('invalid A2A message envelope');
      messages.push(message);
      // Move to processed or delete
      safeUnlinkSync(filePath);
    } catch (err) {
      // AA-05 Task 1.3: a poisoned message must not be retried forever (it
      // would otherwise sit in the inbox and get re-read, re-fail, and
      // re-log on every poll). Quarantine it once instead of losing or
      // looping on it.
      if (!safeExistsSync(A2A_QUARANTINE)) safeMkdir(A2A_QUARANTINE, { recursive: true });
      const quarantinePath = assertSafeRepositoryPath(path.join(A2A_QUARANTINE, file), {
        allowMissingLeaf: true,
      });
      safeMoveSync(filePath, quarantinePath);
      logger.warn(
        `[A2A_Transport] Failed to parse A2A message ${file}, quarantined to ${quarantinePath}: ${err}`
      );
    }
  }

  return messages;
}

/**
 * Hybrid Encryption (AES + RSA) for A2A Payloads.
 */
async function _encryptPayload(plainText: string, publicKeyPath: string): Promise<string> {
  const symKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);

  // Encrypt payload with AES
  const cipher = crypto.createCipheriv('aes-256-cbc', symKey, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  // Encrypt symKey with target's RSA public key
  const safePublicKeyPath = assertSafeRepositoryPath(publicKeyPath);
  if (!safeExistsSync(safePublicKeyPath) || !safeLstat(safePublicKeyPath).isFile()) {
    throw new Error(`[A2A_Transport] public key must be a regular file: ${publicKeyPath}`);
  }
  const publicKey = safeReadFile(safePublicKeyPath, {
    encoding: 'utf8',
  }) as string;
  const encryptedKey = crypto.publicEncrypt(publicKey, symKey).toString('hex');

  return `---ENCRYPTED---\n${encryptedKey}\n${iv.toString('hex')}\n${encrypted}`;
}

async function _decryptPayload(encryptedBlob: string): Promise<string> {
  const lines = encryptedBlob.split('\n');
  const encryptedKey = Buffer.from(lines[1], 'hex');
  const iv = Buffer.from(lines[2], 'hex');
  const encryptedPayload = lines[3];

  // Retrieve our private key passphrase from Keychain
  const getPassInput = pathResolver.sharedTmp('actuators/network-actuator/get-pass-a2a.json');
  safeWriteFile(
    getPassInput,
    JSON.stringify({
      action: 'get',
      params: {
        account: 'sovereign',
        service: 'kyberion-private-key-pass',
        export_as: 'v',
      },
    })
  );

  let pass: string;
  try {
    pass = parseA2ASecretValue(
      parseSafeJsonInput(
        safeExec('node', [
          pathResolver.capabilityEntry('secret-actuator'),
          '--input',
          getPassInput,
        ]),
        '[A2A_Transport] secret actuator response'
      )
    );
  } finally {
    safeUnlinkSync(getPassInput);
  }

  // Decrypt our private key using the passphrase
  const privKeyPath = pathResolver.vault('keys/sovereign-private.pem');
  const safePrivKeyPath = assertSafeRepositoryPath(privKeyPath);
  if (!safeExistsSync(safePrivKeyPath) || !safeLstat(safePrivKeyPath).isFile()) {
    throw new Error('[A2A_Transport] private key must be a regular file');
  }
  const privateKey = crypto.createPrivateKey({
    key: safeReadFile(safePrivKeyPath, { encoding: null }) as Buffer,
    passphrase: pass,
  });

  // Decrypt symKey
  const symKey = crypto.privateDecrypt(privateKey, encryptedKey);

  // Decrypt payload
  const decipher = crypto.createDecipheriv('aes-256-cbc', symKey, iv);
  let decrypted = decipher.update(encryptedPayload, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
