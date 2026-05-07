import { describe, it, expect } from 'vitest';
import {
  classifyError,
  formatClassification,
  getRuleIds,
} from './error-classifier.js';

describe('error-classifier', () => {
  describe('basic shape', () => {
    it('returns "unknown" for an empty error', () => {
      expect(classifyError('').category).toBe('unknown');
      expect(classifyError(new Error('')).category).toBe('unknown');
    });

    it('truncates long messages', () => {
      const long = 'x'.repeat(2000);
      const c = classifyError(long);
      expect(c.detail.length).toBeLessThanOrEqual(501);
      expect(c.detail.endsWith('…')).toBe(true);
    });

    it('exposes a stable list of rule ids', () => {
      const ids = getRuleIds();
      expect(ids.length).toBeGreaterThan(10);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates
    });
  });

  describe('governance + tier rules', () => {
    it('classifies tier-guard violations', () => {
      const c = classifyError(new Error('TIER_VIOLATION: cannot read confidential from public'));
      expect(c.category).toBe('tier_violation');
      expect(c.ruleId).toBe('kyberion.tier-guard');
    });

    it('classifies path-scope policy denials', () => {
      const c = classifyError(
        "[POLICY_VIOLATION] Persona 'unknown' with authority role 'forks' is NOT authorized to write to '/x'.",
      );
      expect(c.category).toBe('permission_denied');
      expect(c.ruleId).toBe('kyberion.path-scope');
    });

    it('classifies project-root path violations', () => {
      const c = classifyError("[POLICY_VIOLATION] Path outside project root: '/tmp/foo'");
      expect(c.category).toBe('permission_denied');
      expect(c.ruleId).toBe('kyberion.path-scope');
    });

    it('classifies approval gate', () => {
      const c = classifyError(new Error('approval required to proceed'));
      expect(c.category).toBe('governance_block');
    });
  });

  describe('auth / secret rules', () => {
    it('classifies invalid api key', () => {
      const c = classifyError(new Error('Invalid API key'));
      expect(c.category).toBe('auth');
    });

    it('classifies 401', () => {
      const c = classifyError('HTTP 401 unauthorized');
      expect(c.category).toBe('auth');
    });

    it('classifies missing secret', () => {
      const c = classifyError('secret not found in keychain');
      expect(c.category).toBe('missing_secret');
    });
  });

  describe('network rules', () => {
    it('classifies ETIMEDOUT by code', () => {
      const err = new Error('connect timeout') as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      expect(classifyError(err).category).toBe('timeout');
    });

    it('classifies ENOTFOUND by code', () => {
      const err = new Error('getaddrinfo failed') as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      expect(classifyError(err).category).toBe('network');
    });

    it('classifies ECONNREFUSED by message', () => {
      expect(classifyError('ECONNREFUSED 127.0.0.1:9999').category).toBe('network');
    });

    it('classifies 429 rate limit', () => {
      expect(classifyError('429 Too Many Requests').category).toBe('rate_limit');
    });
  });

  describe('dependency rules', () => {
    it('classifies missing binary (ENOENT spawn)', () => {
      expect(classifyError('spawn playwright ENOENT').category).toBe('missing_dependency');
    });

    it('classifies playwright not installed', () => {
      expect(classifyError('playwright not installed').category).toBe('missing_dependency');
    });

    it('classifies MODULE_NOT_FOUND by code', () => {
      const err = new Error('Cannot find module foo') as NodeJS.ErrnoException;
      err.code = 'MODULE_NOT_FOUND';
      expect(classifyError(err).category).toBe('missing_dependency');
    });
  });

  describe('resource rules', () => {
    it('classifies EADDRINUSE', () => {
      const err = new Error('listen EADDRINUSE :3000') as NodeJS.ErrnoException;
      err.code = 'EADDRINUSE';
      expect(classifyError(err).category).toBe('resource_unavailable');
    });

    it('classifies ENOSPC', () => {
      expect(classifyError('ENOSPC: no space left on device').category).toBe('resource_unavailable');
    });

    it('classifies EACCES', () => {
      expect(classifyError('EACCES: permission denied').category).toBe('permission_denied');
    });
  });

  describe('input rules', () => {
    it('classifies schema validation', () => {
      expect(classifyError('schema validation failed at /steps/0').category).toBe('invalid_input');
    });

    it('classifies unsupported pipeline op', () => {
      const c = classifyError('Unsupported pipeline op: system:terraform');
      expect(c.category).toBe('invalid_input');
      expect(c.ruleId).toBe('input.unsupported-op');
    });

    it('classifies json parse', () => {
      expect(
        classifyError(new Error('Unexpected token } in JSON at position 42')).category,
      ).toBe('invalid_input');
    });
  });

  describe('mission rules', () => {
    it('classifies mission not found', () => {
      expect(classifyError('Mission MSN-FOO not found.').category).toBe('mission_not_found');
    });
  });

  describe('input shapes', () => {
    it('handles string input', () => {
      expect(classifyError('Cannot find module foo').category).toBe('missing_dependency');
    });

    it('handles { message, code } object', () => {
      expect(classifyError({ message: 'connect failed', code: 'ECONNREFUSED' }).category).toBe(
        'network',
      );
    });

    it('handles weird input gracefully', () => {
      expect(classifyError(null).category).toBe('unknown');
      expect(classifyError(undefined).category).toBe('unknown');
      expect(classifyError(42).category).toBe('unknown');
    });
  });

  describe('formatClassification', () => {
    it('formats with category, label, remediation, detail', () => {
      const c = classifyError('429 Too Many Requests');
      const s = formatClassification(c);
      expect(s).toContain('[rate_limit]');
      expect(s).toContain('Rate limit');
      expect(s).toContain('→');
      expect(s).toContain('detail:');
    });
  });
});
