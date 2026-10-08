import { describe, expect, it } from 'vitest';
import {
  buildVitestArgs,
  buildVitestEnv,
  parseTestSuiteArgs,
  TEST_SUITES,
  runTestSuite,
} from './test_suite.js';

describe('test suite dispatcher', () => {
  it('keeps every named suite explicit and deterministic', () => {
    expect(Object.keys(TEST_SUITES)).toEqual([
      'smoke',
      'unit',
      'core',
      'meeting-dry-run',
      'ui-voice-browser-smoke',
      'actuators',
      'scripts',
      'integration',
      'browser-bridge',
      'meet-copilot',
      'coverage',
      'tui',
    ]);
    expect(buildVitestArgs('core')).toEqual([
      'vitest',
      'run',
      'libs/core/',
      '--no-file-parallelism',
    ]);
  });

  it('extracts suite selection without swallowing Vitest options', () => {
    expect(parseTestSuiteArgs(['--suite', 'core', '--coverage'])).toEqual({
      suite: 'core',
      vitestArgs: ['--coverage'],
    });
    expect(parseTestSuiteArgs(['--suite=meeting-dry-run', '--reporter=dot'])).toEqual({
      suite: 'meeting-dry-run',
      vitestArgs: ['--reporter=dot'],
    });
  });

  it('rejects missing and unknown suite names', () => {
    expect(() => parseTestSuiteArgs(['--suite'])).toThrow('--suite requires a suite name');
    expect(() => parseTestSuiteArgs(['--suite', 'unknown'])).toThrow('unknown test suite');
  });

  it('forwards the leak-guard strict switch past the safeExec env allowlist', () => {
    expect(buildVitestEnv({ KYBERION_TEST_LEAK_STRICT: '1' })).toEqual({
      KYBERION_TEST_LEAK_STRICT: '1',
    });
    expect(buildVitestEnv({})).toEqual({ KYBERION_TEST_LEAK_STRICT: undefined });
  });

  it('requires an explicit argv array at the dispatcher boundary', () => {
    expect(runTestSuite.length).toBe(1);
  });
});
