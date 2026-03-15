import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '../libs/core/index.js';

const rootDir = process.cwd();

describe('Runtime surface governance', () => {
  it('does not duplicate managed surfaces inside active-services', () => {
    const activeServices = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/governance/active-services.json'), { encoding: 'utf8' }) as string,
    ) as Record<string, unknown>;

    expect(Object.keys(activeServices)).not.toContain('nexus-daemon');
    expect(Object.keys(activeServices)).not.toContain('slack-sensor');
  });
});
