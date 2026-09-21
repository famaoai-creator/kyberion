import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';

vi.mock('@agent/core/secret-introduction', () => ({
  proposeSecretIntroduction: vi.fn(() => ({
    approvalId: '11111111-1111-1111-1111-111111111111',
    status: 'approved',
    autoApproved: true,
    identity: {
      serviceId: 'gemini',
      secretKey: 'API_KEY',
      envName: 'GEMINI_API_KEY',
      keychainService: 'gemini',
      keychainAccount: 'api_key',
      connectionField: 'api_key',
    },
    storageChannel: 'terminal',
    channel: 'terminal',
  })),
  applySecretIntroduction: vi.fn(async () => ({
    approvalId: '11111111-1111-1111-1111-111111111111',
    status: 'applied',
    identity: {
      serviceId: 'gemini',
      secretKey: 'API_KEY',
      envName: 'GEMINI_API_KEY',
      keychainService: 'gemini',
      keychainAccount: 'api_key',
      connectionField: 'api_key',
    },
    changedKeys: ['api_key'],
    connectionPath: 'knowledge/personal/connections/gemini.json',
  })),
  describeIntroductionReadiness: vi.fn(() => ({
    serviceId: 'gemini',
    identities: [],
    missing: ['GEMINI_API_KEY'],
  })),
}));

describe('secret_introduce CLI', () => {
  it('refuses --value on argv', async () => {
    const { runSecretCli } = await import('./secret_introduce.js');
    await expect(
      runSecretCli(['introduce', 'gemini', 'API_KEY', '--value', 'nope'], {
        print: () => undefined,
      })
    ).rejects.toThrow(/Refusing --value/);
  });

  it('applies from --from-file without putting the value on argv', async () => {
    const dir = pathResolver.sharedTmp(`tests/secret-cli-${Date.now()}`);
    safeMkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'secret.txt');
    const secretValue = `file-secret-${Date.now()}`;
    safeWriteFile(filePath, secretValue, { encoding: 'utf8' });

    const lines: string[] = [];
    const { runSecretCli } = await import('./secret_introduce.js');
    const { applySecretIntroduction } = await import('@agent/core/secret-introduction');

    try {
      const result = await runSecretCli(
        ['introduce', 'gemini', 'API_KEY', '--from-file', filePath, '--json'],
        { print: (v) => lines.push(String(v)) }
      );

      expect(applySecretIntroduction).toHaveBeenCalledWith(
        expect.objectContaining({ value: secretValue })
      );
      expect(JSON.stringify(result)).not.toContain(secretValue);
      expect(lines.join('\n')).not.toContain(secretValue);
    } finally {
      safeRmSync(dir, { recursive: true, force: true });
    }
  });
});
