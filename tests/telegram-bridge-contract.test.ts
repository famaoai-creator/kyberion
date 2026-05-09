import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Telegram bridge contract', () => {
  it('registers telegram as a governed surface provider and runtime surface', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const manifests = read('knowledge/public/governance/surface-provider-manifests.json');
    const activeSurfaces = read('knowledge/public/governance/active-surfaces.json');
    const lifecycleModel = read('knowledge/public/architecture/runtime-surface-lifecycle-model.md');
    const operatorGuide = read('docs/OPERATOR_UX_GUIDE.md');

    expect(pkg.scripts['telegram:bridge']).toBe('node dist/satellites/telegram-bridge/src/index.js');
    expect(pkg.scripts['telegram:demo']).toBe('pnpm exec tsx scripts/demo_telegram_flow.ts');
    expect(manifests).toContain('"id": "telegram"');
    expect(manifests).toContain('"agentId": "telegram-surface-agent"');
    expect(activeSurfaces).toContain('"id": "telegram-bridge"');
    expect(activeSurfaces).toContain('"MISSION_ROLE": "surface_runtime"');
    expect(lifecycleModel).toContain('telegram-bridge');
    expect(operatorGuide).toContain('telegram-bridge');
  });

  it('simulates telegram conversation through the surface conversation model', () => {
    const demo = read('scripts/demo_telegram_flow.ts');
    expect(demo).toContain("surface: 'telegram'");
    expect(demo).toContain("senderAgentId: 'kyberion:telegram-bridge'");
    expect(demo).toContain("agentId: 'telegram-surface-agent'");
  });
});
