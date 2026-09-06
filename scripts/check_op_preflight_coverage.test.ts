import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  findMissingOpPreflightCoverage,
  maskNonCode,
  OP_PREFLIGHT_BOUNDARIES,
  type OpPreflightCoverageSources,
} from './check_op_preflight_coverage.js';

describe('check_op_preflight_coverage', () => {
  it('uses the foundation text reader for boundary source files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_op_preflight_coverage.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  const sources = (
    overrides: Record<string, string> = {},
    shared: Partial<OpPreflightCoverageSources['shared']> = {}
  ): OpPreflightCoverageSources => ({
    boundaries: Object.fromEntries(
      OP_PREFLIGHT_BOUNDARIES.map((path) => [path, overrides[path] || ''])
    ),
    shared: {
      actuatorSdk: 'ensureDefaultOpPreflight();',
      adfEngine: 'ensureDefaultOpPreflight();',
      ...shared,
    },
  });

  it('ignores comments and literals when looking for a call', () => {
    expect(
      maskNonCode('// runActuatorPipeline();\nconst x = "ensureDefaultOpPreflight();";')
    ).not.toContain('runActuatorPipeline');
    const violations = findMissingOpPreflightCoverage(
      sources({ [OP_PREFLIGHT_BOUNDARIES[0]]: '// ensureDefaultOpPreflight();' })
    );
    expect(violations).toContain(
      `${OP_PREFLIGHT_BOUNDARIES[0]}: missing ensureDefaultOpPreflight connection`
    );
  });

  it('accepts a real shared runner call', () => {
    const violations = findMissingOpPreflightCoverage(
      sources({ [OP_PREFLIGHT_BOUNDARIES[0]]: 'return runActuatorPipeline(options);' })
    );
    expect(violations).not.toContain(
      `${OP_PREFLIGHT_BOUNDARIES[0]}: missing ensureDefaultOpPreflight connection`
    );
  });

  it('accepts a real shared ADF runner call', () => {
    const violations = findMissingOpPreflightCoverage(
      sources({ [OP_PREFLIGHT_BOUNDARIES[0]]: 'return runAdfActuatorPipeline(options);' })
    );
    expect(violations).not.toContain(
      `${OP_PREFLIGHT_BOUNDARIES[0]}: missing ensureDefaultOpPreflight connection`
    );
  });

  it('accepts a real direct preflight call', () => {
    const violations = findMissingOpPreflightCoverage(
      sources({ [OP_PREFLIGHT_BOUNDARIES[0]]: 'ensureDefaultOpPreflight();' })
    );
    expect(violations).not.toContain(
      `${OP_PREFLIGHT_BOUNDARIES[0]}: missing ensureDefaultOpPreflight connection`
    );
  });
});
