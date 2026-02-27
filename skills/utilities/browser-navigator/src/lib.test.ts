import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runBrowserScenario } from './lib';
import { execSync } from 'node:child_process';

vi.mock('node:child_process');

describe('browser-navigator lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should call playwright cli', () => {
    vi.mocked(execSync).mockReturnValue('{"ok": true}');
    runBrowserScenario('test.spec.ts', '/root');
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('playwright test'),
      expect.any(Object)
    );
  });
});
