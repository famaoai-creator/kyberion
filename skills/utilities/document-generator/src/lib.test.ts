import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeDocumentGeneration } from './lib';
import { execSync } from 'node:child_process';

vi.mock('node:child_process');

describe('document-generator lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should call execSync with correct command', () => {
    vi.mocked(execSync).mockReturnValue('{"status": "success", "data": {"message": "ok"}}');
    routeDocumentGeneration('pdf', 'in.md', 'out.pdf', '/root');
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('pdf-composer'),
      expect.any(Object)
    );
  });
});
