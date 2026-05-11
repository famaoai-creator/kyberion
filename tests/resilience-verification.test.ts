import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAction as handleNetworkAction } from '../libs/actuators/network-actuator/src/index';
import * as core from '@agent/core';
import * as network from '@agent/core/network';

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core');
  return {
    ...actual,
    secureFetch: vi.fn(),
  };
});

vi.mock('@agent/core/network', async () => {
  return {
    secureFetch: vi.fn(),
  };
});

describe('Resilience Verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('network-actuator: fetch should retry on failure', async () => {
    const mockFetch = vi.mocked(core.secureFetch);
    
    // Fail twice, succeed on third try
    mockFetch
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ status: 200, data: 'success' });

    const input = {
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'fetch',
          params: {
            url: 'https://example.com',
            max_retries: 2,
            retry_delay_ms: 10
          }
        }
      ]
    };

    const result = await handleNetworkAction(input as any);
    
    expect(result.status).toBe('succeeded');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.context.last_capture.data).toBe('success');
  });

  it('service-actuator: API mode should retry on failure', async () => {
    const { handleAction: handleServiceAction } = await import('../libs/actuators/service-actuator/src/index');
    const mockFetch = vi.mocked(network.secureFetch);
    
    // Fail once, succeed on second try
    mockFetch
      .mockRejectedValueOnce(new Error('Rate limit exceeded'))
      .mockResolvedValueOnce({ status: 200, data: 'service success' });

    const input = {
      service_id: 'example',
      mode: 'API',
      action: 'get_data',
      params: {
        retry: {
          maxRetries: 1,
          initialDelayMs: 10
        }
      }
    };

    const result = await handleServiceAction(input as any);
    
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.data).toBe('service success');
  });
});
