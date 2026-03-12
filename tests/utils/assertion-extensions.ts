/**
 * Assertion Extensions - Custom assertions for testing
 *
 * Provides custom Vitest matchers for validating ADF schemas,
 * mission states, and GEMINI compliance.
 */

import { expect } from 'vitest';
import type { SkillInput } from '@agent/core/types';
import type { MissionContract } from '@agent/core/src/types/mission-contract';

/**
 * Custom matcher interface for TypeScript
 */
interface CustomMatchers<R = unknown> {
  toMatchADFSchema(): R;
  toHaveValidMissionState(): R;
  toBeGEMINICompliant(): R;
}

declare module 'vitest' {
  interface Assertion<T = any> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}

/**
 * Validates that an object matches the ADF (Agentic Data Format) schema
 */
expect.extend({
  toMatchADFSchema(received: unknown) {
    const { isNot } = this;

    // Check if received is an object
    if (typeof received !== 'object' || received === null) {
      return {
        pass: false,
        message: () => `Expected ${received} to be an ADF object`,
      };
    }

    const adf = received as Partial<SkillInput>;

    // Required fields for ADF
    const hasSkill = typeof adf.skill === 'string' && adf.skill.length > 0;
    const hasAction = typeof adf.action === 'string' && adf.action.length > 0;

    const pass = hasSkill && hasAction;

    return {
      pass,
      message: () => {
        if (isNot) {
          return `Expected object not to match ADF schema`;
        }
        const missing: string[] = [];
        if (!hasSkill) missing.push('skill');
        if (!hasAction) missing.push('action');
        return `Expected object to match ADF schema. Missing required fields: ${missing.join(', ')}`;
      },
    };
  },
});

/**
 * Validates that an object has a valid mission state structure
 */
expect.extend({
  toHaveValidMissionState(received: unknown) {
    const { isNot } = this;

    if (typeof received !== 'object' || received === null) {
      return {
        pass: false,
        message: () => `Expected ${received} to be a mission state object`,
      };
    }

    const state = received as any;

    // Required fields for mission state
    const hasMissionId = typeof state.mission_id === 'string' && state.mission_id.length > 0;
    const hasTier = ['personal', 'confidential', 'public'].includes(state.tier);
    const hasStatus = [
      'planned',
      'active',
      'validating',
      'distilling',
      'completed',
      'paused',
      'failed',
      'archived',
    ].includes(state.status);
    const hasExecutionMode = ['local', 'delegated'].includes(state.execution_mode);
    const hasGit = typeof state.git === 'object' && state.git !== null;
    const hasHistory = Array.isArray(state.history);

    const pass = hasMissionId && hasTier && hasStatus && hasExecutionMode && hasGit && hasHistory;

    return {
      pass,
      message: () => {
        if (isNot) {
          return `Expected object not to have valid mission state`;
        }
        const issues: string[] = [];
        if (!hasMissionId) issues.push('mission_id is missing or invalid');
        if (!hasTier) issues.push('tier is missing or invalid');
        if (!hasStatus) issues.push('status is missing or invalid');
        if (!hasExecutionMode) issues.push('execution_mode is missing or invalid');
        if (!hasGit) issues.push('git object is missing');
        if (!hasHistory) issues.push('history array is missing');
        return `Expected object to have valid mission state. Issues: ${issues.join(', ')}`;
      },
    };
  },
});

/**
 * Validates that code or configuration is GEMINI compliant
 */
expect.extend({
  toBeGEMINICompliant(received: unknown) {
    const { isNot } = this;

    if (typeof received !== 'object' || received === null) {
      return {
        pass: false,
        message: () => `Expected ${received} to be a GEMINI-compliant object`,
      };
    }

    const violations: string[] = [];

    // Check for direct fs usage (should use @agent/core/secure-io)
    const codeString = JSON.stringify(received);
    if (codeString.includes("require('fs')") || codeString.includes("from 'fs'")) {
      violations.push('Direct fs usage detected (use @agent/core/secure-io)');
    }
    if (codeString.includes("require('node:fs')") || codeString.includes("from 'node:fs'")) {
      violations.push('Direct node:fs usage detected (use @agent/core/secure-io)');
    }

    // Check for direct child_process usage
    if (
      codeString.includes("require('child_process')") ||
      codeString.includes("from 'child_process'")
    ) {
      violations.push('Direct child_process usage detected (use @agent/core/secure-io safeExec)');
    }
    if (
      codeString.includes("require('node:child_process')") ||
      codeString.includes("from 'node:child_process'")
    ) {
      violations.push(
        'Direct node:child_process usage detected (use @agent/core/secure-io safeExec)'
      );
    }

    // Check for mission contract structure if applicable
    const contract = received as Partial<MissionContract>;
    if (contract.mission_id && contract.skill && contract.action) {
      // This looks like a mission contract - validate ADF structure
      if (!contract.skill || !contract.action) {
        violations.push('Mission contract missing required ADF fields (skill, action)');
      }
    }

    const pass = violations.length === 0;

    return {
      pass,
      message: () => {
        if (isNot) {
          return `Expected object not to be GEMINI compliant`;
        }
        return `Expected object to be GEMINI compliant. Violations: ${violations.join('; ')}`;
      },
    };
  },
});

export {};
