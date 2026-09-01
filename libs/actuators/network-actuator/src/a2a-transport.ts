import { logger } from '@agent/core/core';
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
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * A2A Physical Transport Layer v1.0
 * Handles physical delivery and encryption of A2A Envelopes.
 */

const A2A_INBOX = pathResolver.rootResolve('active/shared/runtime/a2a/inbox');
const A2A_OUTBOX = pathResolver.rootResolve('active/shared/runtime/a2a/outbox');
const A2A_QUARANTINE = path.join(A2A_INBOX, '.quarantine');

interface TransportOptions {
  method: 'local';
  encrypt: boolean;
  target_public_key?: string;
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
export async function sendA2AMessage(message: any, options: TransportOptions) {
  const msgId = message.header.msg_id;
  let payload = JSON.stringify(message);

  if (options.encrypt && options.target_public_key) {
    logger.info(`🔒 [A2A_Transport] Encrypting message ${msgId}...`);
    payload = await _encryptPayload(payload, options.target_public_key);
  }

  if (options.method === 'local') {
    if (!safeExistsSync(A2A_OUTBOX)) safeMkdir(A2A_OUTBOX, { recursive: true });
    if (typeof msgId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(msgId)) {
      throw new Error(`[A2A_Transport] invalid message id for local outbox: ${String(msgId)}`);
    }
    const outPath = assertSafeRepositoryPath(path.join(A2A_OUTBOX, `${msgId}.a2a`), {
      allowMissingLeaf: true,
    });
    safeWriteFile(outPath, payload);
    logger.success(`📥 [A2A_Transport] Message ${msgId} placed in local outbox.`);
  }
}

/**
 * Checks for new A2A messages in the physical inbox.
 */
export async function pollA2AInbox(): Promise<A2AInboxMessage[]> {
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
      const message = parseA2AInboxMessage(JSON.parse(content) as unknown);
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
  const publicKey = safeReadFile(safePublicKeyPath, { encoding: 'utf8' }) as string;
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
      params: { account: 'sovereign', service: 'kyberion-private-key-pass', export_as: 'v' },
    })
  );

  let pass: string;
  try {
    pass = parseA2ASecretValue(
      JSON.parse(
        safeExec('node', [pathResolver.capabilityEntry('secret-actuator'), '--input', getPassInput])
      ) as unknown
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
