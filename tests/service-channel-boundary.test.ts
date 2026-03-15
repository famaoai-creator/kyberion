import { describe, expect, it } from 'vitest';
import { safeReadFile } from '../libs/core/secure-io.js';

function read(relPath: string): string {
  return safeReadFile(relPath, { encoding: 'utf8' }) as string;
}

describe('Service and channel boundary', () => {
  it('uses shared service bindings for Slack gateway ingress and channel delivery', () => {
    const slackBridge = read('satellites/slack-bridge/src/index.ts');
    const presenceActuator = read('libs/actuators/presence-actuator/src/index.ts');

    expect(slackBridge).toContain('resolveServiceBinding(\'slack\', \'secret-guard\')');
    expect(presenceActuator).toContain('resolveServiceBinding(\'slack\', \'secret-guard\')');
  });

  it('keeps Slack streaming ingress out of the service actuator', () => {
    const serviceActuator = read('libs/actuators/service-actuator/src/index.ts');

    expect(serviceActuator).toContain('Slack streaming ingress belongs to the Slack gateway');
  });
});
