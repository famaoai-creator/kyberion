import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanKnowledgeTiers } from './lib';
import * as fs from 'node:fs';
import * as fsUtils from '@agent/core/fs-utils';

vi.mock('node:fs');
vi.mock('@agent/core/fs-utils');

describe('auto-context-mapper lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should detect tiers based on path', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fsUtils.getAllFiles).mockReturnValue([
      '/root/knowledge/public/doc.md',
      '/root/knowledge/personal/secrets.json',
      '/root/knowledge/confidential/client.yaml',
    ]);

    const tiers = scanKnowledgeTiers('/root');
    expect(tiers.public).toHaveLength(1);
    expect(tiers.personal).toHaveLength(1);
    expect(tiers.confidential).toHaveLength(1);
  });
});
