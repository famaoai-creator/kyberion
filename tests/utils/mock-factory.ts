/**
 * Mock Factory - Test utilities for creating mock objects
 *
 * Provides helpers for mocking actuators, file system, and network operations
 * to facilitate testing without external dependencies.
 */

import { vi } from 'vitest';
import type { SkillOutput, SkillInput } from '@agent/core/types';

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
  defaultResponse?: Partial<SkillOutput>
): MockActuator {
  const execute = vi.fn().mockResolvedValue({
    skill: type,
    status: 'success',
    data: {},
    metadata: {
      timestamp: new Date().toISOString(),
    },
    ...defaultResponse,
  } as SkillOutput);

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
 * Creates a mock skill input for testing
 *
 * @param overrides - Partial SkillInput to override defaults
 * @returns Complete SkillInput object
 */
export function createMockSkillInput(overrides?: Partial<SkillInput>): SkillInput {
  return {
    skill: 'test-skill',
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
 * Creates a mock skill output for testing
 *
 * @param overrides - Partial SkillOutput to override defaults
 * @returns Complete SkillOutput object
 */
export function createMockSkillOutput<T = unknown>(
  overrides?: Partial<SkillOutput<T>>
): SkillOutput<T> {
  return {
    skill: 'test-skill',
    status: 'success',
    data: {} as T,
    metadata: {
      timestamp: new Date().toISOString(),
      duration_ms: 100,
    },
    ...overrides,
  };
}
