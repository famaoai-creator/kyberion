import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

const mocks = vi.hoisted(() => ({
  installReasoningBackends: vi.fn(() => false),
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@agent/core/reasoning-bootstrap', () => ({
  installReasoningBackends: mocks.installReasoningBackends,
}));

vi.mock('@agent/core/core', () => ({
  logger: mocks.logger,
}));

import { main } from './chat_local.js';

describe('chat_local', () => {
  it('routes REPL output through the supplied printer and delegates failure handling', async () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/chat_local.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
    expect(source).not.toContain('process.exitCode =');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');

    await expect(main([], vi.fn())).rejects.toMatchObject({
      code: 1,
      message: 'Failed to initialize local reasoning backend.',
    });
  });
});
