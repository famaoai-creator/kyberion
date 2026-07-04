import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';

function read(relPath: string): string {
  return safeReadFile(relPath, { encoding: 'utf8' }) as string;
}

describe('Service and channel boundary', () => {
  it('uses shared service bindings for Slack gateway ingress and channel delivery', () => {
    const slackBridge = read('satellites/slack-bridge/src/index.ts');
    // presence-actuator delegates to helpers; check the helpers file where Slack binding is used
    const presenceActuatorHelpers = read('libs/actuators/presence-actuator/src/presence-actuator-helpers.ts');

    expect(slackBridge).toContain("resolveServiceBinding('slack', 'secret-guard')");
    expect(presenceActuatorHelpers).toContain("resolveServiceBinding('slack', 'secret-guard')");
  });

  it('keeps Slack streaming ingress out of the service actuator', () => {
    const serviceActuator = read('libs/actuators/service-actuator/src/index.ts');

    expect(serviceActuator).toContain('Slack streaming ingress belongs to the Slack gateway');
  });
});
