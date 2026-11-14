import { describe, expect, it } from 'vitest';
import {
  checkActionRuntime,
  checkCiWorkflowContract,
  checkWorkflowDocument,
  resolvePinnedRefs,
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

  it('reads the major of a SHA-pinned action from its trailing comment', () => {
    const sha = 'a'.repeat(40);
    const raw = `      - uses: actions/checkout@${sha} # v4.2.2\n      - uses: actions/setup-node@${'b'.repeat(40)}\n`;
    const refs = resolvePinnedRefs(
      [`actions/checkout@${sha}`, `actions/setup-node@${'b'.repeat(40)}`],
      raw
    );
    expect(refs[0]).toBe('actions/checkout@v4');
    expect(checkActionRuntime('wf.yml', refs).map((v) => v.detail)).toEqual([
      expect.stringContaining('deprecated Node runtime'),
      expect.stringContaining('no verifiable major'),
    ]);
  });
});
