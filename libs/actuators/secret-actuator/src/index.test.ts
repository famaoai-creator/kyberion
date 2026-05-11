import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, pathResolver } from '@agent/core';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(),
  withRetry: vi.fn(async (fn: () => Promise<any>) => fn()),
  ledgerRecord: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    safeExec: mocks.safeExec,
    withRetry: mocks.withRetry,
    logger: mocks.logger,
    ledger: { record: mocks.ledgerRecord },
  };
});

describe('secret-actuator: governed mutation', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let platformSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  });

  afterEach(() => {
    process.env = originalEnv;
    platformSpy?.mockRestore();
  });

  it('should auto-wrap secret mutation in an ephemeral mission if MISSION_ID is absent, and record to ledger', async () => {
    delete process.env.MISSION_ID;

    // We mock safeExec to pretend both the mission controller and the security commands succeed.
    mocks.safeExec.mockImplementation((bin: string, args: string[]) => {
      if (bin === 'pnpm' && args.includes('mission_controller.ts')) return 'Mocked mission command';
      if (bin === 'security') return 'Mocked keychain success';
      return '';
    });

    const { handleAction } = await import('./index');

    const input = {
      action: 'set' as const,
      params: { account: 'test_user', service: 'slack', value: 'secret123' },
    };

    const result = await handleAction(input);

    expect(result.status).toBe('success');
    expect(result.mission_id).toBeDefined(); // Should return the auto-generated ephemeral mission ID
    expect(mocks.withRetry).toHaveBeenCalled();

    // Verify that the mission controller was called to create and finish the mission
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining([
        'tsx',
        expect.stringContaining('mission_controller.ts'),
        'create',
        expect.stringContaining('MSN-SEC-'),
      ])
    );
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining([
        'tsx',
        expect.stringContaining('mission_controller.ts'),
        'finish',
        expect.stringContaining('MSN-SEC-'),
      ])
    );

    // Verify ledger record
    expect(mocks.ledgerRecord).toHaveBeenCalledWith(
      'CONFIG_CHANGE',
      expect.objectContaining({
        mission_id: expect.stringContaining('MSN-SEC-'),
        service_id: 'slack',
        action: 'set',
      })
    );
  });

  it('should use existing MISSION_ID and record to ledger without creating a new mission', async () => {
    process.env.MISSION_ID = 'EXISTING-MISSION-123';

    mocks.safeExec.mockImplementation((bin: string, args: string[]) => {
      if (bin === 'security') return 'Mocked keychain success';
      return '';
    });

    const { handleAction } = await import('./index');

    const input = {
      action: 'set' as const,
      params: { account: 'test_user', service: 'slack', value: 'secret123' },
    };

    const result = await handleAction(input);

    expect(result.status).toBe('success');
    expect(mocks.withRetry).toHaveBeenCalled();

    // Mission controller should NOT be called
    expect(mocks.safeExec).not.toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining(['tsx', expect.stringContaining('mission_controller.ts')])
    );

    // Verify ledger record uses the existing mission ID
    expect(mocks.ledgerRecord).toHaveBeenCalledWith(
      'CONFIG_CHANGE',
      expect.objectContaining({
        mission_id: 'EXISTING-MISSION-123',
        service_id: 'slack',
        action: 'set',
      })
    );
  });

  it('emits secret actions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'schemas/secret-action.schema.json')
    );
    const action = {
      action: 'set',
      params: {
        account: 'test_user',
        service: 'slack',
        value: 'secret123',
      },
    };
    const valid = validate(action);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('get action retrieves a secret from keychain', async () => {
    mocks.safeExec.mockImplementation((bin: string, args: string[]) => {
      if (bin === 'security' && args.includes('find-generic-password')) return 'my-secret-value';
      return '';
    });

    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'get',
      params: { account: 'test_user', service: 'slack', export_as: 'slack_token' },
    });

    expect(result.status).toBe('success');
    expect(result.slack_token).toBe('my-secret-value');
  });

  it('get action returns failed when secret not found', async () => {
    mocks.safeExec.mockImplementation((bin: string, args: string[]) => {
      if (bin === 'security' && args.includes('find-generic-password')) {
        throw new Error(
          'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'
        );
      }
      return '';
    });

    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'get',
      params: { account: 'test_user', service: 'nonexistent_service' },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });

  it('delete action removes a secret from keychain', async () => {
    process.env.MISSION_ID = 'EXISTING-MISSION-123';
    mocks.safeExec.mockImplementation((bin: string, args: string[]) => {
      if (bin === 'security') return 'Mocked keychain success';
      return '';
    });

    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'delete',
      params: { account: 'test_user', service: 'slack' },
    });

    expect(result.status).toBe('success');
    expect(mocks.withRetry).toHaveBeenCalled();
  });

  it('throws for unsupported action', async () => {
    const { handleAction } = await import('./index');
    await expect(
      handleAction({ action: 'unsupported' as any, params: { account: 'a', service: 'b' } })
    ).rejects.toThrow('Unsupported secret action');
  });

  it('set action throws when value is missing', async () => {
    process.env.MISSION_ID = 'EXISTING-MISSION-123';
    mocks.safeExec.mockReturnValue('');

    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'set',
      params: { account: 'test_user', service: 'slack' }, // no value
    });

    // The error is caught by withGovernedMutation and returned as failed
    expect(result.status).toBe('failed');
  });
});
