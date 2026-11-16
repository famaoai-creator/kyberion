import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

const files = vi.hoisted(() => new Map<string, string>());

vi.mock('@agent/core/path-resolver', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown> & { pathResolver: object };
  const rootResolve = (relative: string) =>
    relative.startsWith('/') ? relative : `/repo/${relative.replace(/^\.\//, '')}`;
  return {
    ...original,
    rootResolve,
    pathResolver: { ...original.pathResolver, rootDir: () => '/repo', rootResolve },
  };
});
vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  safeReadFile: (file: string) => {
    const content = files.get(file);
    if (content === undefined) throw new Error(`missing ${file}`);
    return content;
  },
}));
vi.mock('@agent/core/secret/secret-identity', () => {
  const normalizeSecretKey = (key: string) => key.toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  return {
    normalizeSecretKey,
    buildEnvSecretName: (service: string, key: string) =>
      `${service.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${normalizeSecretKey(key)}`,
  };
});

import { describeApprovalQueueProfile, main } from './approval_queue_profile_cli.js';

const PROFILE_PATH = 'knowledge/confidential/acme/approval-queues/shonin-time.json';
const CONTENT = `${JSON.stringify(
  {
    version: 1,
    system: 'shonin-time',
    origins: ['https://wf.example.jp'],
    credential: { service: 'shonin-time', user_key: 'login_user', password_key: 'login_password' },
    login: {
      url: 'https://wf.example.jp/login',
      user_selector: '#u',
      password_selector: '#p',
      submit_selector: '#s',
      success_selector: '#menu',
    },
    list: { ready_selector: 'main', row_selector: 'tr.item', empty_selector: '.empty' },
  },
  null,
  2
)}\n`;
files.set(`/repo/${PROFILE_PATH}`, CONTENT);

describe('approval-queue profile CLI', () => {
  it('prints the exact grant a charter signs, hashing the file bytes', () => {
    const summary = describeApprovalQueueProfile(PROFILE_PATH);
    const hash = createHash('sha256').update(CONTENT).digest('hex');
    expect(summary).toMatchObject({
      tenant: 'acme',
      delegable: true,
      credential: { secrets: ['SHONIN_TIME_LOGIN_USER', 'SHONIN_TIME_LOGIN_PASSWORD'] },
      grant: {
        operation_id: 'browser:approval_queue_inspect',
        origin: 'https://wf.example.jp',
        profile_hash: hash,
      },
    });
  });

  it('refuses a file outside the tenant profile directory', () => {
    expect(() =>
      describeApprovalQueueProfile('knowledge/confidential/acme/charters/x.json')
    ).toThrow(/APPROVAL_QUEUE_PROFILE_PATH/);
  });

  it('tells the reader that any byte change needs a new signature', async () => {
    const lines: string[] = [];
    await main([PROFILE_PATH], (line) => lines.push(line));
    expect(lines.join('\n')).toMatch(/SHA-256: +[0-9a-f]{64}[\s\S]+Any byte change/);
  });
});
