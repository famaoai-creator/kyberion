import { describe, expect, it } from 'vitest';
import {
  describeChangedGateMatch,
  matchesGatePath,
  selectChangedGates,
  validateGatePaths,
  type PathTriggeredGate,
} from './changed-gate-selection.js';

const gates: PathTriggeredGate[] = [
  { id: 'lint', scope: 'pr' },
  {
    id: 'op-registry',
    scope: 'full',
    paths: ['libs/actuators/**', 'scripts/generate_op_registry.ts'],
  },
  { id: 'vocabulary', scope: 'full', paths: ['knowledge/product/orchestration/*-vocabulary.json'] },
  { id: 'wiring', scope: 'full', paths: ['{libs,scripts}/**/*.{ts,tsx}'] },
  { id: 'audit', scope: 'full' },
  { id: 'evidence-complete', scope: 'release', paths: ['docs/operator/**'] },
];

describe('changed gate glob matching', () => {
  it('keeps * inside one segment and lets ** cross segments', () => {
    expect(matchesGatePath('libs/actuators/a/src/x.ts', 'libs/actuators/**')).toBe(true);
    expect(matchesGatePath('libs/actuators', 'libs/actuators/**')).toBe(false);
    expect(matchesGatePath('libs/core/a.ts', 'libs/*.ts')).toBe(false);
    expect(matchesGatePath('libs/a.ts', 'libs/*.ts')).toBe(true);
    expect(matchesGatePath('libs/a/b/c.ts', 'libs/**/c.ts')).toBe(true);
    expect(matchesGatePath('libs/c.ts', 'libs/**/c.ts')).toBe(true);
    expect(matchesGatePath('libs/core/op-input-contracts.ts', 'libs/core/op-input-contract*')).toBe(
      true
    );
  });

  it('supports {a,b} alternation, ? and normalizes Windows separators', () => {
    expect(matchesGatePath('scripts/x.tsx', '{libs,scripts}/**/*.{ts,tsx}')).toBe(true);
    expect(matchesGatePath('presence/x.ts', '{libs,scripts}/**/*.{ts,tsx}')).toBe(false);
    expect(matchesGatePath('a1.json', 'a?.json')).toBe(true);
    expect(matchesGatePath('a/1.json', 'a?.json')).toBe(false);
    expect(matchesGatePath('libs\\actuators\\x.ts', 'libs/actuators/**')).toBe(true);
  });

  it('treats regex metacharacters in patterns literally', () => {
    expect(matchesGatePath('package.json', 'package.json')).toBe(true);
    expect(matchesGatePath('packageXjson', 'package.json')).toBe(false);
  });
});

describe('selectChangedGates', () => {
  it('always keeps every pr gate, even with no changed files', () => {
    const selection = selectChangedGates(gates, []);
    expect(selection.gates.map((gate) => gate.id)).toEqual(['lint']);
    expect(selection.extra).toEqual([]);
  });

  it('adds full and release gates whose paths match, in manifest order', () => {
    const selection = selectChangedGates(gates, [
      'docs/operator/runbook.md',
      'libs/actuators/browser-actuator/manifest.json',
      './knowledge/product/orchestration/user-facing-vocabulary.json',
    ]);
    expect(selection.gates.map((gate) => gate.id)).toEqual([
      'lint',
      'op-registry',
      'vocabulary',
      'evidence-complete',
    ]);
    expect(selection.extra.find((entry) => entry.id === 'vocabulary')?.matches).toEqual([
      {
        file: 'knowledge/product/orchestration/user-facing-vocabulary.json',
        pattern: 'knowledge/product/orchestration/*-vocabulary.json',
      },
    ]);
  });

  it('never selects a full gate without paths and records every matching file', () => {
    const selection = selectChangedGates(gates, [
      'scripts/generate_op_registry.ts',
      'scripts/lib/other.ts',
    ]);
    expect(selection.gates.map((gate) => gate.id)).toEqual(['lint', 'op-registry', 'wiring']);
    expect(selection.gates.some((gate) => gate.id === 'audit')).toBe(false);
    const wiring = selection.extra.find((entry) => entry.id === 'wiring')!;
    expect(wiring.matches.map((match) => match.file)).toEqual([
      'scripts/generate_op_registry.ts',
      'scripts/lib/other.ts',
    ]);
    expect(describeChangedGateMatch(wiring)).toBe(
      '+ wiring [full] ← scripts/generate_op_registry.ts matches {libs,scripts}/**/*.{ts,tsx} (+1 more)'
    );
  });
});

describe('validateGatePaths', () => {
  it('accepts absent or well-formed paths', () => {
    expect(validateGatePaths({ id: 'a', scope: 'full' })).toEqual([]);
    expect(validateGatePaths({ id: 'a', scope: 'full', paths: ['libs/**'] })).toEqual([]);
  });

  it('rejects paths on pr gates, empty lists, absolute or escaping and unterminated globs', () => {
    expect(validateGatePaths({ id: 'a', scope: 'pr', paths: ['libs/**'] })[0]).toMatch(
      /pr gates always run/
    );
    expect(validateGatePaths({ id: 'a', scope: 'full', paths: [] })[0]).toMatch(/non-empty/);
    expect(validateGatePaths({ id: 'a', scope: 'full', paths: ['/etc/**'] })[0]).toMatch(
      /repo-relative/
    );
    expect(validateGatePaths({ id: 'a', scope: 'full', paths: ['../x'] })[0]).toMatch(
      /repo-relative/
    );
    expect(validateGatePaths({ id: 'a', scope: 'full', paths: ['libs/{a,b'] })[0]).toMatch(
      /unterminated/
    );
  });
});
