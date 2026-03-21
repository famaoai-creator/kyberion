import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAction } from './index.js';
import * as core from '@agent/core';

// Mock core functions
vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    safeReadFile: vi.fn(),
    safeExec: vi.fn(),
    resolveServiceBinding: vi.fn(() => ({ accessToken: 'test-token' })),
    platform: {
      checkBinary: vi.fn(),
    },
  };
});

// Mock network
vi.mock('@agent/core/network', () => ({
  secureFetch: vi.fn(),
}));

import { secureFetch } from '@agent/core/network';

describe('Service-Actuator: Adaptive Presets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KYBERION_ALLOW_UNSAFE_CLI = 'true';
  });

  it('should fall back to API when CLI binary is missing', async () => {
    // 1. Setup Mocks
    const mockEndpoints = {
      services: {
        'test-service': { preset_path: 'mock/path.json', base_url: 'https://api.test.com' }
      }
    };
    const mockPreset = {
      operations: {
        'do_action': {
          type: 'auto',
          alternatives: [
            { type: 'cli', command: 'missing-cli', args: ['run'], output_mapping: { "res": "out" } },
            { type: 'api', path: 'action', method: 'GET', output_mapping: { "res": "data.id" } }
          ]
        }
      }
    };

    (core.safeReadFile as any).mockImplementation((path: string) => {
      if (path.includes('service-endpoints.json')) return JSON.stringify(mockEndpoints);
      if (path.includes('mock/path.json')) return JSON.stringify(mockPreset);
      return '';
    });

    (core.platform.checkBinary as any).mockResolvedValue(false); // CLI is missing
    (secureFetch as any).mockResolvedValue({ data: { id: 'api-success' } });

    // 2. Execute
    const result = await handleAction({
      service_id: 'test-service',
      mode: 'PRESET',
      action: 'do_action',
      params: {}
    });

    // 3. Verify
    expect(core.platform.checkBinary).toHaveBeenCalledWith('missing-cli');
    expect(secureFetch).toHaveBeenCalled();
    expect(result).toEqual({ res: 'api-success' });
  });

  it('should use CLI when binary exists and mapping is correct', async () => {
    // 1. Setup Mocks
    const mockEndpoints = {
      services: {
        'test-service': { preset_path: 'mock/path.json' }
      }
    };
    const mockPreset = {
      operations: {
        'do_action': {
          type: 'auto',
          alternatives: [
            { type: 'cli', command: 'found-cli', args: ['--json'], output_mapping: { "res": "status" } }
          ]
        }
      }
    };

    (core.safeReadFile as any).mockImplementation((path: string) => {
      if (path.includes('service-endpoints.json')) return JSON.stringify(mockEndpoints);
      if (path.includes('mock/path.json')) return JSON.stringify(mockPreset);
      return '';
    });

    (core.platform.checkBinary as any).mockResolvedValue(true); // CLI exists
    (core.safeExec as any).mockReturnValue(JSON.stringify({ status: 'cli-ok', junk: 'data' }));

    // 2. Execute
    const result = await handleAction({
      service_id: 'test-service',
      mode: 'PRESET',
      action: 'do_action',
      params: {}
    });

    // 3. Verify
    expect(core.safeExec).toHaveBeenCalledWith('found-cli', ['--json']);
    expect(result).toEqual({ res: 'cli-ok' });
  });

  it('should correctly resolve variables in API path and payload', async () => {
    const mockEndpoints = { services: { 's': { preset_path: 'p.json', base_url: 'https://b.com' } } };
    const mockPreset = {
      operations: {
        'op': {
          type: 'api',
          path: 'users/{{id}}',
          method: 'POST',
          payload_template: { "msg": "Hello {{name}}" }
        }
      }
    };

    (core.safeReadFile as any).mockImplementation((path: string) => {
      if (path.includes('service-endpoints.json')) return JSON.stringify(mockEndpoints);
      if (path.includes('p.json')) return JSON.stringify(mockPreset);
      return '';
    });

    (secureFetch as any).mockResolvedValue({ ok: true });

    await handleAction({
      service_id: 's',
      mode: 'PRESET',
      action: 'op',
      params: { id: '123', name: 'famao' }
    });

    expect(secureFetch).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://b.com/users/123',
      data: { msg: 'Hello famao' },
      headers: expect.objectContaining({
        'Authorization': 'Bearer test-token'
      })
    }));
  });
});
