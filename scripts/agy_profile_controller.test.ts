import { describe, expect, it, vi, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { listProfiles, addProfile, deleteProfile, main } from './agy_profile_controller.js';
import { pathResolver } from '@agent/core/path-resolver';

describe('agy_profile_controller', () => {
  it('lists default profile', () => {
    const profiles = listProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    expect(profiles[0].name).toBe('default');
  });

  it('rejects reserved profile name default for add', () => {
    expect(() => addProfile('default')).toThrow("'default' is reserved");
  });

  it('rejects invalid characters in profile name', () => {
    expect(() => addProfile('work;rm')).toThrow('alphanumeric');
    expect(() => addProfile('../traversal')).toThrow('alphanumeric');
  });

  it('prints help message', async () => {
    const lines: string[] = [];
    await main(['help'], (msg) => lines.push(String(msg)));
    expect(lines.join('\n')).toContain('Usage: pnpm kyberion agy profile');
    expect(lines.join('\n')).toContain('setup-host');
  });

  it('runs setup-host without crashing', async () => {
    const lines: string[] = [];
    await main(['setup-host'], (msg) => lines.push(String(msg)));
    expect(lines.join('\n')).toContain('Installed CLI scripts');
  });
});
