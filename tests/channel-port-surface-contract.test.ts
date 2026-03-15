import { describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile } from '../libs/core/secure-io.js';

describe('Channel port and surface-agent contract', () => {
  it('ships the architecture and schema for channel ports and surface agents', () => {
    expect(safeExistsSync('knowledge/public/architecture/channel-port-surface-model.md')).toBe(true);
    expect(safeExistsSync('knowledge/public/schemas/channel-port.schema.json')).toBe(true);
    expect(safeExistsSync('knowledge/agents/slack-surface-agent.agent.md')).toBe(true);
    expect(safeExistsSync('knowledge/agents/nerve-agent.agent.md')).toBe(true);
  });

  it('defines the expected port taxonomy', () => {
    const schema = JSON.parse(
      safeReadFile('knowledge/public/schemas/channel-port.schema.json', { encoding: 'utf8' }) as string
    );

    expect(schema.properties.role.enum).toEqual([
      'sensor',
      'emitter',
      'gateway',
      'control-surface',
      'display'
    ]);
    expect(schema.properties.directionality.enum).toEqual([
      'receive-only',
      'send-only',
      'request-response',
      'streaming-duplex'
    ]);
    expect(schema.properties.transport.enum).toEqual([
      'poll',
      'webhook',
      'socket',
      'push-api',
      'file-drop',
      'interactive-session'
    ]);
  });

  it('documents Slack and Chronos as surface-agent-backed channels', () => {
    const doc = safeReadFile(
      'knowledge/public/architecture/channel-port-surface-model.md',
      { encoding: 'utf8' }
    ) as string;

    expect(doc).toContain('Slack Surface Agent');
    expect(doc).toContain('Chronos Surface Agent');
    expect(doc).toContain('channel-local agent');
  });
});
