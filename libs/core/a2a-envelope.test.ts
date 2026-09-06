import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { loadA2AEnvelopeAtPath } from './a2a-envelope.js';

const root = pathResolver.sharedTmp(`a2a-envelope-loader-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

describe('A2A envelope loader', () => {
  it('loads a valid envelope through the schema-bound file loader', () => {
    const file = path.join(root, 'message.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(
      file,
      JSON.stringify({
        a2a_version: '1.0',
        header: { msg_id: 'msg-1', sender: 'agent:sender', performative: 'request' },
        payload: { task: 'demo' },
      })
    );

    expect(loadA2AEnvelopeAtPath(file)).toMatchObject({
      a2a_version: '1.0',
      header: { msg_id: 'msg-1' },
    });
  });

  it('rejects malformed envelopes before dispatch', () => {
    const file = path.join(root, 'message.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(file, JSON.stringify({ payload: {} }));

    expect(() => loadA2AEnvelopeAtPath(file)).toThrow(/Invalid catalog a2a-envelope/u);
  });

  it('rejects symlinked envelopes before JSON read', () => {
    const outside = path.join(root, 'outside');
    const link = path.join(root, 'message.json');
    safeMkdir(outside, { recursive: true });
    safeWriteFile(
      path.join(outside, 'real.json'),
      JSON.stringify({
        a2a_version: '1.0',
        header: { msg_id: 'msg-1', sender: 'agent:sender', performative: 'request' },
        payload: {},
      })
    );
    safeSymlinkSync(path.join(outside, 'real.json'), link);

    expect(() => loadA2AEnvelopeAtPath(link)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
