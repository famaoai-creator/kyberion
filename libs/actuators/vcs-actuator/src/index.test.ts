/**
 * Tests for vcs-actuator.
 *
 * git-dependent read ops run against the real repository checkout (read-only),
 * so these tests focus on catalog shape and input validation. Write-path ops
 * (commit, pr_create) are covered by negative validation tests only — they
 * must never execute against the working tree in unit tests.
 */
import { describe, it, expect } from 'vitest';
import { describeOps } from './op-catalog.js';
import { handleAction } from './vcs-helpers.js';

describe('vcs-actuator op catalog', () => {
  it('lists 6 ops with capture/apply kinds', () => {
    const ops = describeOps();
    expect(ops).toHaveLength(6);
    const byOp = Object.fromEntries(ops.map((spec) => [spec.op, spec.kind]));
    expect(byOp).toEqual({
      status: 'capture',
      diff: 'capture',
      log: 'capture',
      branch: 'apply',
      commit: 'apply',
      pr_create: 'apply',
    });
  });

  it('gives every op an input schema and examples', () => {
    for (const spec of describeOps()) {
      expect(spec.input_schema).toBeTruthy();
      expect(spec.examples?.length).toBeGreaterThan(0);
    }
  });
});

describe('vcs-actuator input validation', () => {
  it('accepts status with cwd omitted (defaults to repo root)', async () => {
    const result = await handleAction({ op: 'status', params: {} });
    expect(result).toEqual(expect.objectContaining({ op: 'status' }));
  });

  it('accepts status with no params at all', async () => {
    const result = await handleAction({ op: 'status' });
    expect(result).toEqual(expect.objectContaining({ op: 'status' }));
  });

  it('rejects commit without a message', async () => {
    await expect(handleAction({ op: 'commit', params: {} })).rejects.toThrow(
      /missing required fields.*params\.message/i
    );
  });

  it('rejects commit with a blank message', async () => {
    await expect(handleAction({ op: 'commit', params: { message: '  ' } })).rejects.toThrow(
      /missing required fields.*params\.message/i
    );
  });

  it('rejects pr_create without a title', async () => {
    await expect(handleAction({ op: 'pr_create', params: {} })).rejects.toThrow(
      /missing required fields.*params\.title/i
    );
  });

  it('rejects branch create without a name', async () => {
    await expect(handleAction({ op: 'branch', params: { action: 'create' } })).rejects.toThrow(
      /missing required fields.*params\.name/i
    );
  });

  it('reads recent log entries', async () => {
    const result = await handleAction({ op: 'log', params: { limit: 1 } });
    expect(result).toEqual(expect.objectContaining({ op: 'log' }));
  });

  it('reads the working-tree diff', async () => {
    const result = await handleAction({ op: 'diff', params: { stat: true } });
    expect(result).toEqual(expect.objectContaining({ op: 'diff' }));
  });

  it('rejects unknown ops via schema validation', async () => {
    await expect(handleAction({ op: 'destroy' as never })).rejects.toThrow(/invalid input/i);
  });
});
