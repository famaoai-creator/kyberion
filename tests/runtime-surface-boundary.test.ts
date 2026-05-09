import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Runtime surface boundary', () => {
  it('declares surface lifecycle through the active surfaces manifest', () => {
    const manifest = read('knowledge/public/governance/active-surfaces.json');
    expect(manifest).toContain('"id": "slack-bridge"');
    expect(manifest).toContain('"id": "imessage-bridge"');
    expect(manifest).toContain('"id": "discord-bridge"');
    expect(manifest).toContain('"id": "telegram-bridge"');
    expect(manifest).toContain('"MISSION_ROLE": "surface_runtime"');
    expect(manifest).toContain('"id": "chronos-mirror-v2"');
    expect(manifest).toContain('"id": "nexus-daemon"');
    expect(manifest).toContain('"id": "terminal-bridge"');
  });

  it('keeps Slack streaming ingress in the gateway layer, not service-actuator', () => {
    const serviceActuator = read('libs/actuators/service-actuator/src/index.ts');
    expect(serviceActuator).toContain('Slack streaming ingress belongs to the Slack gateway');
  });

  it('documents the canonical surface lifecycle controller', () => {
    const componentMap = read('docs/COMPONENT_MAP.md');
    const slackChronosModel = read('knowledge/public/architecture/slack-chronos-control-model.md');
    const lifecycleModel = read('knowledge/public/architecture/runtime-surface-lifecycle-model.md');

    expect(componentMap).toContain('scripts/surface_runtime.ts');
    expect(slackChronosModel).toContain('active-surfaces.json');
    expect(slackChronosModel).toContain('surface_runtime.ts');
    expect(lifecycleModel).toContain('knowledge/public/governance/surfaces/*.json');
    expect(lifecycleModel).toContain('active-surfaces.json');
  });
});
