/**
 * Test suite for test utilities
 *
 * Validates that mock-factory, fixture-generator, and assertion-extensions
 * work correctly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createMockActuator,
  createMockFileSystem,
  createMockNetwork,
  createMockSkillInput,
  createMockSkillOutput,
} from './mock-factory';
import {
  generateADF,
  generateMissionContract,
  generateTestData,
  generateMissionState,
} from './fixture-generator';
import './assertion-extensions';

describe('Mock Factory', () => {
  describe('createMockActuator', () => {
    it('should create a mock actuator with default response', async () => {
      const mock = createMockActuator('test-actuator');
      const result = await mock.execute();

      expect(result.skill).toBe('test-actuator');
      expect(result.status).toBe('success');
      expect(mock.execute).toHaveBeenCalledTimes(1);
    });

    it('should allow custom default response', async () => {
      const mock = createMockActuator('test-actuator', {
        status: 'error',
        error: { code: 'TEST_ERROR', message: 'Test error' },
      });
      const result = await mock.execute();

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('TEST_ERROR');
    });

    it('should reset call count', async () => {
      const mock = createMockActuator('test-actuator');
      await mock.execute();
      await mock.execute();
      expect(mock.execute).toHaveBeenCalledTimes(2);

      mock.reset();
      expect(mock.execute).toHaveBeenCalledTimes(0);
    });
  });

  describe('createMockFileSystem', () => {
    it('should create a mock file system', async () => {
      const fs = createMockFileSystem();

      const content = await fs.readFile('test.txt');
      expect(content).toBe('mock file content');
      expect(fs.exists('test.txt')).toBe(true);
    });
  });

  describe('createMockNetwork', () => {
    it('should create a mock network interface', async () => {
      const network = createMockNetwork();

      const response = await network.fetch('https://example.com');
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
    });
  });

  describe('createMockSkillInput', () => {
    it('should create a mock skill input', () => {
      const input = createMockSkillInput();

      expect(input.skill).toBe('test-skill');
      expect(input.action).toBe('test-action');
      expect(input.context?.knowledge_tier).toBe('public');
    });

    it('should allow overrides', () => {
      const input = createMockSkillInput({
        skill: 'custom-skill',
        action: 'custom-action',
      });

      expect(input.skill).toBe('custom-skill');
      expect(input.action).toBe('custom-action');
    });
  });

  describe('createMockSkillOutput', () => {
    it('should create a mock skill output', () => {
      const output = createMockSkillOutput();

      expect(output.skill).toBe('test-skill');
      expect(output.status).toBe('success');
      expect(output.metadata?.timestamp).toBeDefined();
    });
  });
});

describe('Fixture Generator', () => {
  describe('generateADF', () => {
    it('should generate a valid ADF object', () => {
      const adf = generateADF();

      expect(adf.skill).toBeDefined();
      expect(adf.action).toBeDefined();
      expect(adf.params).toBeDefined();
      expect(adf.context?.knowledge_tier).toBe('public');
    });

    it('should accept custom options', () => {
      const adf = generateADF({
        skill: 'custom-skill',
        action: 'custom-action',
        tier: 'confidential',
      });

      expect(adf.skill).toBe('custom-skill');
      expect(adf.action).toBe('custom-action');
      expect(adf.context?.knowledge_tier).toBe('confidential');
    });
  });

  describe('generateMissionContract', () => {
    it('should generate a valid mission contract', () => {
      const contract = generateMissionContract();

      expect(contract.mission_id).toBeDefined();
      expect(contract.skill).toBeDefined();
      expect(contract.action).toBeDefined();
    });

    it('should include safety gate when specified', () => {
      const contract = generateMissionContract({
        risk_level: 3,
        require_sudo: true,
      });

      expect(contract.safety_gate).toBeDefined();
      expect(contract.safety_gate?.risk_level).toBe(3);
      expect(contract.safety_gate?.require_sudo).toBe(true);
    });
  });

  describe('generateTestData', () => {
    it('should generate data from a simple schema', () => {
      const data = generateTestData<{ name: string; age: number; active: boolean }>({
        name: 'string',
        age: 'number',
        active: 'boolean',
      });

      expect(typeof data.name).toBe('string');
      expect(typeof data.age).toBe('number');
      expect(typeof data.active).toBe('boolean');
    });

    it('should handle nested objects', () => {
      const data = generateTestData<{ user: { name: string; email: string } }>({
        user: {
          type: 'object',
          properties: {
            name: 'string',
            email: 'string',
          },
        },
      });

      expect(data.user).toBeDefined();
      expect(typeof data.user.name).toBe('string');
      expect(typeof data.user.email).toBe('string');
    });

    it('should handle arrays', () => {
      const data = generateTestData<{ tags: string[] }>({
        tags: { type: 'array', items: 'string' },
      });

      expect(Array.isArray(data.tags)).toBe(true);
      expect(data.tags.length).toBeGreaterThan(0);
    });
  });

  describe('generateMissionState', () => {
    it('should generate a valid mission state', () => {
      const state = generateMissionState();

      expect(state.mission_id).toBeDefined();
      expect(state.tier).toBe('public');
      expect(state.status).toBe('planned');
      expect(state.git).toBeDefined();
      expect(state.history).toBeDefined();
    });
  });
});

describe('Assertion Extensions', () => {
  describe('toMatchADFSchema', () => {
    it('should pass for valid ADF objects', () => {
      const adf = generateADF();
      expect(adf).toMatchADFSchema();
    });

    it('should fail for invalid ADF objects', () => {
      const invalid = { skill: 'test' }; // missing action
      expect(() => expect(invalid).toMatchADFSchema()).toThrow();
    });
  });

  describe('toHaveValidMissionState', () => {
    it('should pass for valid mission states', () => {
      const state = generateMissionState();
      expect(state).toHaveValidMissionState();
    });

    it('should fail for invalid mission states', () => {
      const invalid = { mission_id: 'test' }; // missing required fields
      expect(() => expect(invalid).toHaveValidMissionState()).toThrow();
    });
  });

  describe('toBeGEMINICompliant', () => {
    it('should pass for GEMINI-compliant objects', () => {
      const compliant = {
        code: "import { safeRead } from '@agent/core/secure-io';",
      };
      expect(compliant).toBeGEMINICompliant();
    });

    it('should fail for objects with direct fs usage', () => {
      const nonCompliant = {
        code: "import fs from 'fs';",
      };
      expect(() => expect(nonCompliant).toBeGEMINICompliant()).toThrow();
    });

    it('should fail for objects with direct child_process usage', () => {
      const nonCompliant = {
        code: "import { exec } from 'child_process';",
      };
      expect(() => expect(nonCompliant).toBeGEMINICompliant()).toThrow();
    });
  });
});
