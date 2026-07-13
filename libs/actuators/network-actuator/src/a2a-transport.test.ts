import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { pollA2AInbox, sendA2AMessage } from './a2a-transport.js';

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

  it('processes good messages and quarantines bad ones in the same poll', async () => {
    writeInboxFile('good.a2a', JSON.stringify({ header: { msg_id: 'good' }, body: {} }));
    writeInboxFile('poison.a2a', '{not-json');

    const messages = await pollA2AInbox();

    expect(messages).toEqual([{ header: { msg_id: 'good' }, body: {} }]);
    expect(safeExistsSync(path.join(A2A_QUARANTINE, 'poison.a2a'))).toBe(true);
  });
});
