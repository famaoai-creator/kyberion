/**
 * Mock Factory - Test utilities for creating mock objects
 *
 * Provides helpers for mocking actuators, file system, and network operations
 * to facilitate testing without external dependencies.
 */

import { vi } from 'vitest';
import type { CapabilityOutput, CapabilityInput } from '@agent/core/types';

/**
 * Mock Actuator interface
 */
export interface MockActuator {
  execute: ReturnType<typeof vi.fn>;
  reset: () => void;
}

/**
 * Mock File System interface
 */
export interface MockFileSystem {
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  readdir: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  reset: () => void;
}

/**
 * Mock Network interface
 */
export interface MockNetwork {
  fetch: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  reset: () => void;
}

/**
 * Creates a mock actuator with configurable behavior
 *
 * @param type - The actuator type (e.g., 'file', 'network', 'browser')
 * @param defaultResponse - Default response for execute calls
 * @returns MockActuator instance
 */
export function createMockActuator(
  type: string,
  defaultResponse?: Partial<CapabilityOutput>
): MockActuator {
  const execute = vi.fn().mockResolvedValue({
    capability: type,
    status: 'success',
    data: {},
    metadata: {
      timestamp: new Date().toISOString(),
    },
    ...defaultResponse,
  } as CapabilityOutput);

  return {
    execute,
    reset: () => execute.mockClear(),
  };
}

/**
 * Creates a mock file system with common operations
 *
 * @returns MockFileSystem instance
 */
export function createMockFileSystem(): MockFileSystem {
  const readFile = vi.fn().mockResolvedValue('mock file content');
  const writeFile = vi.fn().mockResolvedValue(undefined);
  const exists = vi.fn().mockReturnValue(true);
  const mkdir = vi.fn().mockResolvedValue(undefined);
  const readdir = vi.fn().mockResolvedValue([]);
  const stat = vi.fn().mockResolvedValue({
    isFile: () => true,
    isDirectory: () => false,
    size: 1024,
    mtime: new Date(),
  });

  return {
    readFile,
    writeFile,
    exists,
    mkdir,
    readdir,
    stat,
    reset: () => {
      readFile.mockClear();
      writeFile.mockClear();
      exists.mockClear();
      mkdir.mockClear();
      readdir.mockClear();
      stat.mockClear();
    },
  };
}

/**
 * Creates a mock network interface
 *
 * @returns MockNetwork instance
 */
export function createMockNetwork(): MockNetwork {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
    headers: new Headers(),
  });

  const request = vi.fn().mockResolvedValue({
    statusCode: 200,
    body: '',
    headers: {},
  });

  return {
    fetch,
    request,
    reset: () => {
      fetch.mockClear();
      request.mockClear();
    },
  };
}

/**
 * Creates a mock capability input for testing
 *
 * @param overrides - Partial CapabilityInput to override defaults
 * @returns Complete CapabilityInput object
 */
export function createMockCapabilityInput(overrides?: Partial<CapabilityInput>): CapabilityInput {
  return {
    capability: 'test-capability',
    action: 'test-action',
    params: {},
    context: {
      knowledge_tier: 'public',
      caller: 'test',
    },
    ...overrides,
  };
}

/**
 * Creates a mock capability output for testing
 *
 * @param overrides - Partial CapabilityOutput to override defaults
 * @returns Complete CapabilityOutput object
 */
export function createMockCapabilityOutput<T = unknown>(
  overrides?: Partial<CapabilityOutput<T>>
): CapabilityOutput<T> {
  return {
    capability: 'test-capability',
    status: 'success',
    data: {} as T,
    metadata: {
      timestamp: new Date().toISOString(),
      duration_ms: 100,
    },
    ...overrides,
  };
}

export const createMockSkillInput = createMockCapabilityInput;
export const createMockSkillOutput = createMockCapabilityOutput;
