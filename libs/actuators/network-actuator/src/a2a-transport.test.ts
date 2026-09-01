import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { parseA2ASecretValue, pollA2AInbox, sendA2AMessage } from './a2a-transport.js';

const A2A_INBOX = pathResolver.rootResolve('active/shared/runtime/a2a/inbox');
const A2A_OUTBOX = pathResolver.rootResolve('active/shared/runtime/a2a/outbox');
const A2A_QUARANTINE = path.join(A2A_INBOX, '.quarantine');

function writeInboxFile(name: string, content: string) {
  if (!safeExistsSync(A2A_INBOX)) safeMkdir(A2A_INBOX, { recursive: true });
  safeWriteFile(path.join(A2A_INBOX, name), content);
}

describe('a2a-transport', () => {
  beforeEach(() => {
    if (safeExistsSync(A2A_INBOX)) safeRmSync(A2A_INBOX, { recursive: true, force: true });
    if (safeExistsSync(A2A_OUTBOX)) safeRmSync(A2A_OUTBOX, { recursive: true, force: true });
  });

  afterEach(() => {
    if (safeExistsSync(A2A_INBOX)) safeRmSync(A2A_INBOX, { recursive: true, force: true });
    if (safeExistsSync(A2A_OUTBOX)) safeRmSync(A2A_OUTBOX, { recursive: true, force: true });
  });

  it('writes a local message to the outbox', async () => {
    await sendA2AMessage(
      { header: { msg_id: 'msg-1' }, body: { hello: 'world' } },
      { method: 'local', encrypt: false }
    );

    const outPath = path.join(A2A_OUTBOX, 'msg-1.a2a');
    expect(safeExistsSync(outPath)).toBe(true);
    expect(JSON.parse(safeReadFile(outPath, { encoding: 'utf8' }) as string)).toMatchObject({
      header: { msg_id: 'msg-1' },
    });
  });

  it('rejects a message id that could escape the local outbox', async () => {
    await expect(
      sendA2AMessage(
        { header: { msg_id: '../outside' }, body: {} },
        { method: 'local', encrypt: false }
      )
    ).rejects.toThrow('invalid message id');
  });

  it('parses and consumes well-formed inbox messages', async () => {
    writeInboxFile('good.a2a', JSON.stringify({ header: { msg_id: 'good' }, body: {} }));

    const messages = await pollA2AInbox();

    expect(messages).toEqual([{ header: { msg_id: 'good' }, body: {} }]);
    // Consumed messages are removed from the inbox (at-most-once).
    expect(safeReaddir(A2A_INBOX).filter((f) => f.endsWith('.a2a'))).toHaveLength(0);
  });

  it('quarantines a message that fails to parse instead of deleting or retrying it forever', async () => {
    writeInboxFile('poison.a2a', '{not-json');

    const firstPoll = await pollA2AInbox();
    expect(firstPoll).toEqual([]);

    // The poisoned file must be out of the inbox (so it isn't re-read and
    // re-logged on every future poll)...
    expect(safeReaddir(A2A_INBOX).filter((f) => f.endsWith('.a2a'))).toHaveLength(0);

    // ...but preserved, not silently lost.
    const quarantinedPath = path.join(A2A_QUARANTINE, 'poison.a2a');
    expect(safeExistsSync(quarantinedPath)).toBe(true);
    expect(safeReadFile(quarantinedPath, { encoding: 'utf8' })).toBe('{not-json');

    // A second poll must not re-process the quarantined file.
    const secondPoll = await pollA2AInbox();
    expect(secondPoll).toEqual([]);
  });

  it('quarantines JSON with an invalid A2A envelope shape', async () => {
    writeInboxFile('invalid-shape.a2a', JSON.stringify({ header: { msg_id: '../escape' } }));

    await expect(pollA2AInbox()).resolves.toEqual([]);
    expect(safeExistsSync(path.join(A2A_QUARANTINE, 'invalid-shape.a2a'))).toBe(true);
  });

  it('processes good messages and quarantines bad ones in the same poll', async () => {
    writeInboxFile('good.a2a', JSON.stringify({ header: { msg_id: 'good' }, body: {} }));
    writeInboxFile('poison.a2a', '{not-json');

    const messages = await pollA2AInbox();

    expect(messages).toEqual([{ header: { msg_id: 'good' }, body: {} }]);
    expect(safeExistsSync(path.join(A2A_QUARANTINE, 'poison.a2a'))).toBe(true);
  });

  it('skips a directory masquerading as an inbox message', async () => {
    if (!safeExistsSync(A2A_INBOX)) safeMkdir(A2A_INBOX, { recursive: true });
    safeMkdir(path.join(A2A_INBOX, 'directory.a2a'), { recursive: true });

    await expect(pollA2AInbox()).resolves.toEqual([]);
  });

  it('rejects a non-regular public key path before reading it', async () => {
    safeMkdir(path.join(A2A_OUTBOX, 'public-key'), { recursive: true });

    await expect(
      sendA2AMessage(
        { header: { msg_id: 'encrypted' }, body: {} },
        {
          method: 'local',
          encrypt: true,
          target_public_key: path.join(A2A_OUTBOX, 'public-key'),
        }
      )
    ).rejects.toThrow('public key must be a regular file');
  });

  it('accepts only a successful secret response with a string passphrase', () => {
    expect(parseA2ASecretValue({ status: 'success', v: 'passphrase' })).toBe('passphrase');
    expect(() => parseA2ASecretValue({ status: 'failed', v: 'passphrase' })).toThrow(
      'did not return the A2A passphrase'
    );
    expect(() => parseA2ASecretValue([])).toThrow('must be an object');
  });
});
