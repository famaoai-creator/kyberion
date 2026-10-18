import { describe, expect, it } from 'vitest';
import { classifyProbeSet } from './decision-axis.js';
import type { RunOutcome } from './probe-runner.js';

const out = (label: string, delivered: boolean, wall_ms = 100): RunOutcome => ({
  label,
  run_dir: `/tmp/${label}`,
  ok: true,
  delivered,
  exit_code: delivered ? 0 : 1,
  wall_ms,
  produced_files: delivered ? ['out.txt'] : [],
  error: delivered ? '' : 'exit=1',
  recorded_at: 't',
});

describe('classifyProbeSet', () => {
  const wall = [{ key: 'wall_ms', direction: 'lower' as const }];

  it('declines when no candidate ran', () => {
    const r = classifyProbeSet(out('base', true), [], wall);
    expect(r.decision).toBe('decline');
    expect(r.auto_advance_allowed).toBe(false);
  });
  it('declines when nothing delivered', () => {
    const r = classifyProbeSet(out('base', false), [out('c1', false), out('c2', false)], wall);
    expect(r.decision).toBe('decline');
  });
  it('keep_base when base delivered but no candidate did', () => {
    const r = classifyProbeSet(out('base', true), [out('c1', false)], wall);
    expect(r.decision).toBe('keep_base');
  });
  it('keep_base when base ties on metrics', () => {
    const r = classifyProbeSet(out('base', true, 100), [out('c1', true, 100)], wall);
    expect(r.decision).toBe('keep_base');
  });
  it('auto_advance: base failed, exactly one candidate delivered', () => {
    const r = classifyProbeSet(out('base', false), [out('c1', true), out('c2', false)], wall);
    expect(r.decision).toBe('auto_advance');
    expect(r.winner).toBe('c1');
    expect(r.auto_advance_allowed).toBe(true);
  });
  it('auto_advance: single candidate dominating base on metrics', () => {
    const r = classifyProbeSet(out('base', true, 200), [out('c1', true, 50)], wall);
    expect(r.decision).toBe('auto_advance');
    expect(r.winner).toBe('c1');
  });
  it('human_gate: base failed but two candidates delivered', () => {
    const r = classifyProbeSet(out('base', false), [out('c1', true), out('c2', true)], wall);
    expect(r.decision).toBe('human_gate');
    expect(r.winner).toBeNull();
  });
  it('human_gate: winner beats base but not a rival', () => {
    const r = classifyProbeSet(
      out('base', true, 300),
      [out('c1', true, 100), out('c2', true, 50)],
      wall
    );
    expect(r.decision).toBe('human_gate');
  });
});

describe('classifyProbeSet — round-2 edge cases', () => {
  const wall = [{ key: 'wall_ms', direction: 'lower' as const }];
  const dead = (label: string): RunOutcome => ({
    label,
    run_dir: `/x/${label}`,
    ok: false,
    delivered: false,
    exit_code: null,
    wall_ms: 0,
    produced_files: [],
    error: 'spawn',
    recorded_at: 't',
  });

  it('human_gate when base is null and a candidate delivered', () => {
    const r = classifyProbeSet(null, [out('c1', true)], wall);
    expect(r.decision).toBe('human_gate');
  });
  it('human_gate when base probe never executed but candidate delivered', () => {
    const r = classifyProbeSet(dead('base'), [out('c1', true)], wall);
    expect(r.decision).toBe('human_gate');
  });
  it('human_gate when base delivered, candidate delivered, no metrics declared', () => {
    const r = classifyProbeSet(out('base', true), [out('c1', true)], []);
    expect(r.decision).toBe('human_gate');
    expect(r.auto_advance_allowed).toBe(false);
  });
});
