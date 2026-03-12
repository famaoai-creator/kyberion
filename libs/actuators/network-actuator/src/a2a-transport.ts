import { 
  logger, 
  safeReadFile, 
  safeWriteFile, 
  safeMkdir, 
  safeExistsSync, 
  pathResolver, 
  safeExec,
  withRetry 
} from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

/**
 * A2A Physical Transport Layer v1.0
 * Handles physical delivery and encryption of A2A Envelopes.
 */

const A2A_INBOX = pathResolver.rootResolve('active/shared/runtime/a2a/inbox');
const A2A_OUTBOX = pathResolver.rootResolve('active/shared/runtime/a2a/outbox');

interface TransportOptions {
  method: 'local' | 'gist';
  encrypt: boolean;
  target_public_key?: string;
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
    const outPath = path.join(A2A_OUTBOX, `${msgId}.a2a`);
    safeWriteFile(outPath, payload);
    logger.success(`📥 [A2A_Transport] Message ${msgId} placed in local outbox.`);
  } else if (options.method === 'gist') {
    // Future: implement gh gist create
    logger.info('🚀 [A2A_Transport] Gist transport triggered (Placeholder).');
  }
}

/**
 * Checks for new A2A messages in the physical inbox.
 */
export async function pollA2AInbox(): Promise<any[]> {
  if (!safeExistsSync(A2A_INBOX)) return [];
  
  const files = fs.readdirSync(A2A_INBOX).filter(f => f.endsWith('.a2a'));
  const messages: any[] = [];

  for (const file of files) {
    const filePath = path.join(A2A_INBOX, file);
    let content = safeReadFile(filePath, { encoding: 'utf8' }) as string;

    if (content.startsWith('---ENCRYPTED---')) {
      logger.info(`🔓 [A2A_Transport] Decrypting message ${file}...`);
      content = await _decryptPayload(content);
    }

    try {
      messages.push(JSON.parse(content));
      // Move to processed or delete
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error(`Failed to parse A2A message ${file}: ${err}`);
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
  const publicKey = fs.readFileSync(publicKeyPath, 'utf8');
  const encryptedKey = crypto.publicEncrypt(publicKey, symKey).toString('hex');

  return `---ENCRYPTED---\n${encryptedKey}\n${iv.toString('hex')}\n${encrypted}`;
}

async function _decryptPayload(encryptedBlob: string): Promise<string> {
  const lines = encryptedBlob.split('\n');
  const encryptedKey = Buffer.from(lines[1], 'hex');
  const iv = Buffer.from(lines[2], 'hex');
  const encryptedPayload = lines[3];

  // Retrieve our private key passphrase from Keychain
  const getPassInput = pathResolver.rootResolve('scratch/get-pass-a2a.json');
  safeWriteFile(getPassInput, JSON.stringify({
    action: 'get',
    params: { account: 'sovereign', service: 'kyberion-private-key-pass', export_as: 'v' }
  }));
  
  const passResult = JSON.parse(safeExec('npx', ['tsx', 'libs/actuators/secret-actuator/src/index.ts', '--input', getPassInput]));
  const pass = passResult.v;
  fs.unlinkSync(getPassInput);

  // Decrypt our private key using the passphrase
  const privKeyPath = pathResolver.vault('keys/sovereign-private.pem');
  const privateKey = crypto.createPrivateKey({
    key: fs.readFileSync(privKeyPath),
    passphrase: pass
  });

  // Decrypt symKey
  const symKey = crypto.privateDecrypt(privateKey, encryptedKey);

  // Decrypt payload
  const decipher = crypto.createDecipheriv('aes-256-cbc', symKey, iv);
  let decrypted = decipher.update(encryptedPayload, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
