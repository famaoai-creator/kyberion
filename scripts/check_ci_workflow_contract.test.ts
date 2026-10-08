import { describe, expect, it } from 'vitest';
import {
  checkActionRuntime,
  checkCiWorkflowContract,
  checkWorkflowDocument,
} from './check_ci_workflow_contract.js';

describe('check_ci_workflow_contract', () => {
  it('passes the repository workflows', () => {
    expect(checkCiWorkflowContract()).toEqual([]);
  });

  it('requires concurrency on pull_request workflows', () => {
    const violations = checkWorkflowDocument('wf.yml', {
      on: { pull_request: { branches: ['main'] } },
      jobs: { a: { 'runs-on': 'ubuntu-latest', 'timeout-minutes': 10, steps: [] } },
    });
    expect(violations.map((v) => v.rule)).toEqual(['pr-concurrency']);
  });

  it('reads the YAML 1.1 `on: true` key the parser produces', () => {
    const violations = checkWorkflowDocument('wf.yml', {
      true: ['pull_request'],
      jobs: {},
    });
    expect(violations.map((v) => v.rule)).toEqual(['pr-concurrency']);
  });

  it('does not require concurrency on push-only workflows', () => {
    expect(
      checkWorkflowDocument('wf.yml', {
        on: { push: { tags: ['v*'] } },
        jobs: { a: { 'runs-on': 'ubuntu-latest', 'timeout-minutes': 10 } },
      })
    ).toEqual([]);
  });

  it('flags jobs without timeout-minutes but not reusable-workflow calls', () => {
    const violations = checkWorkflowDocument('wf.yml', {
      on: 'push',
      jobs: {
        missing: { 'runs-on': 'ubuntu-latest', steps: [] },
        reusable: { uses: './.github/workflows/other.yml' },
      },
    });
    expect(violations).toEqual([
      expect.objectContaining({ rule: 'job-timeout', detail: expect.stringContaining('missing') }),
    ]);
  });

  it('flags Node20-era action majors', () => {
    expect(
      checkActionRuntime('wf.yml', [
        'actions/checkout@v4',
        'actions/checkout@v5',
        'actions/upload-artifact@v5',
        './.github/actions/setup-kyberion',
        'some/other-action@v1',
      ]).map((v) => v.detail)
    ).toEqual([
      expect.stringContaining('actions/checkout@v4'),
      expect.stringContaining('actions/upload-artifact@v5'),
    ]);
  });

  it('flags a separate core build before the full build', () => {
    const violations = checkWorkflowDocument('wf.yml', {
      on: 'push',
      jobs: {
        a: {
          'runs-on': 'ubuntu-latest',
          'timeout-minutes': 10,
          steps: [{ run: "pnpm --filter '@agent/core' build" }, { run: 'pnpm run build' }],
        },
      },
    });
    expect(violations.map((v) => v.rule)).toEqual(['redundant-core-build']);
  });
});
