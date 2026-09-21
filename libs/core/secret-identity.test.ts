import { describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  buildEnvSecretName,
  parseEnvSecretName,
  resolveSecretIdentity,
  secretKeyToConnectionField,
} from './secret-identity.js';

describe('secret-identity', () => {
  it('maps service + suffix to env, keychain, and connection field', () => {
    const identity = resolveSecretIdentity('gemini', 'API_KEY');
    expect(identity).toEqual({
      serviceId: 'gemini',
      secretKey: 'API_KEY',
      envName: 'GEMINI_API_KEY',
      keychainService: 'gemini',
      keychainAccount: 'api_key',
      connectionField: 'api_key',
    });
    expect(buildEnvSecretName('gemini', 'API_KEY')).toBe('GEMINI_API_KEY');
    expect(secretKeyToConnectionField('API_KEY')).toBe('api_key');
  });

  it('parses env names with longest known service prefix', () => {
    const gemini = parseEnvSecretName('GEMINI_API_KEY');
    expect(gemini?.serviceId).toBe('gemini');
    expect(gemini?.secretKey).toBe('API_KEY');

    const scoped = parseEnvSecretName('GEMINI_API_KEY', 'gemini');
    expect(scoped?.envName).toBe('GEMINI_API_KEY');
    expect(parseEnvSecretName('GEMINI_API_KEY', 'slack')).toBeNull();
  });

  it('rejects invalid service ids', () => {
    expect(() => resolveSecretIdentity('../evil', 'API_KEY')).toThrow(/SECRET_IDENTITY_INVALID/);
  });
});

describe('secret-bridge macOS stdin write contract', () => {
  it('documents that MacKeychainSecretProvider.set must not put value on argv', async () => {
    const bridge = await import('./secret-bridge.js');
    expect(typeof bridge.storeSecret).toBe('function');
    expect(typeof bridge.fetchSecretSync).toBe('function');
  });

  it('uses swift stdin helper instead of security -w value', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/secret-bridge.ts'), { encoding: 'utf8' })
    );
    expect(source).toMatch(/spawn\(\s*'swift'/);
    expect(source).not.toMatch(/'add-generic-password'[\s\S]{0,120}'-w',\s*value/);
  });
});
