/**
 * Tests for the semver classification + bump satisfaction logic in check_contract_semver.
 *
 * The script is procedural, so we re-implement the same classification helpers here
 * (kept in sync) and test the rules directly. This is a guard against rule drift.
 */
import { describe, it, expect } from 'vitest';

interface Fingerprint {
  actuator_id: string;
  version: string;
  ops: string[];
  contract_schema: string | null;
  contract_schema_sha256: string | null;
}

type BumpLevel = 'none' | 'patch' | 'minor' | 'major';

function classifyBump(prev: Fingerprint, next: Fingerprint): BumpLevel {
  const prevOps = new Set(prev.ops);
  const nextOps = new Set(next.ops);
  const removed = [...prevOps].filter(o => !nextOps.has(o));
  const added = [...nextOps].filter(o => !prevOps.has(o));
  if (removed.length > 0) return 'major';
  let level: BumpLevel = 'none';
  if (added.length > 0) level = 'minor';
  if (prev.contract_schema_sha256 !== next.contract_schema_sha256 && level === 'none') level = 'minor';
  if (prev.contract_schema !== next.contract_schema && level === 'none') level = 'minor';
  return level;
}

function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
}

function bumpSatisfies(prev: string, next: string, required: BumpLevel): boolean {
  if (required === 'none') return true;
  const pp = parseSemver(prev);
  const pn = parseSemver(next);
  if (!pp || !pn) return prev !== next;
  if (required === 'major') return pn[0] > pp[0];
  if (required === 'minor') return pn[0] > pp[0] || pn[1] > pp[1];
  if (required === 'patch') {
    if (pn[0] > pp[0]) return true;
    if (pn[0] < pp[0]) return false;
    if (pn[1] > pp[1]) return true;
    if (pn[1] < pp[1]) return false;
    return pn[2] > pp[2];
  }
  return true;
}

const baseFp: Fingerprint = {
  actuator_id: 'demo',
  version: '1.0.0',
  ops: ['a', 'b'],
  contract_schema: 'schemas/demo.schema.json',
  contract_schema_sha256: 'abc',
};

describe('classifyBump', () => {
  it('returns none for identical surfaces', () => {
    expect(classifyBump(baseFp, { ...baseFp })).toBe('none');
  });

  it('returns minor for added op', () => {
    expect(classifyBump(baseFp, { ...baseFp, ops: ['a', 'b', 'c'] })).toBe('minor');
  });

  it('returns major for removed op', () => {
    expect(classifyBump(baseFp, { ...baseFp, ops: ['a'] })).toBe('major');
  });

  it('returns major when ops both added and removed', () => {
    expect(classifyBump(baseFp, { ...baseFp, ops: ['a', 'c'] })).toBe('major');
  });

  it('returns minor for schema content change', () => {
    expect(
      classifyBump(baseFp, { ...baseFp, contract_schema_sha256: 'def' }),
    ).toBe('minor');
  });

  it('returns minor for schema path change', () => {
    expect(
      classifyBump(baseFp, { ...baseFp, contract_schema: 'schemas/demo-v2.schema.json' }),
    ).toBe('minor');
  });
});

describe('bumpSatisfies', () => {
  it('any bump satisfies none', () => {
    expect(bumpSatisfies('1.0.0', '1.0.0', 'none')).toBe(true);
    expect(bumpSatisfies('1.0.0', '1.0.1', 'none')).toBe(true);
  });

  it('minor satisfied by minor or major', () => {
    expect(bumpSatisfies('1.0.0', '1.1.0', 'minor')).toBe(true);
    expect(bumpSatisfies('1.0.0', '2.0.0', 'minor')).toBe(true);
  });

  it('minor not satisfied by patch', () => {
    expect(bumpSatisfies('1.0.0', '1.0.1', 'minor')).toBe(false);
  });

  it('minor not satisfied by no change', () => {
    expect(bumpSatisfies('1.0.0', '1.0.0', 'minor')).toBe(false);
  });

  it('major requires major bump', () => {
    expect(bumpSatisfies('1.0.0', '2.0.0', 'major')).toBe(true);
    expect(bumpSatisfies('1.0.0', '1.99.0', 'major')).toBe(false);
    expect(bumpSatisfies('1.0.0', '1.0.99', 'major')).toBe(false);
  });

  it('handles versions that span multi-level bumps', () => {
    expect(bumpSatisfies('1.5.3', '2.0.0', 'major')).toBe(true);
    expect(bumpSatisfies('1.5.3', '1.6.0', 'minor')).toBe(true);
    expect(bumpSatisfies('1.5.3', '1.5.4', 'patch')).toBe(true);
  });

  it('non-semver versions accept any string change but reject no-change when bump required', () => {
    expect(bumpSatisfies('foo', 'bar', 'major')).toBe(true);
    expect(bumpSatisfies('foo', 'foo', 'major')).toBe(false); // no change cannot satisfy a required bump
    expect(bumpSatisfies('foo', 'foo', 'none')).toBe(true);
  });
});

describe('end-to-end: classify + check', () => {
  function isViolation(prev: Fingerprint, next: Fingerprint): boolean {
    const required = classifyBump(prev, next);
    if (required === 'none') return false;
    return !bumpSatisfies(prev.version, next.version, required);
  }

  it('removed op without major bump: violation', () => {
    const prev = { ...baseFp, version: '1.0.0' };
    const next = { ...baseFp, version: '1.5.0', ops: ['a'] };
    expect(isViolation(prev, next)).toBe(true);
  });

  it('removed op with major bump: ok', () => {
    const prev = { ...baseFp, version: '1.0.0' };
    const next = { ...baseFp, version: '2.0.0', ops: ['a'] };
    expect(isViolation(prev, next)).toBe(false);
  });

  it('added op with minor bump: ok', () => {
    const prev = { ...baseFp, version: '1.0.0' };
    const next = { ...baseFp, version: '1.1.0', ops: ['a', 'b', 'c'] };
    expect(isViolation(prev, next)).toBe(false);
  });

  it('added op with patch bump: violation', () => {
    const prev = { ...baseFp, version: '1.0.0' };
    const next = { ...baseFp, version: '1.0.1', ops: ['a', 'b', 'c'] };
    expect(isViolation(prev, next)).toBe(true);
  });

  it('schema changed without bump: violation', () => {
    const prev = { ...baseFp, version: '1.0.0' };
    const next = { ...baseFp, version: '1.0.0', contract_schema_sha256: 'xyz' };
    expect(isViolation(prev, next)).toBe(true);
  });

  it('schema changed with minor bump: ok', () => {
    const prev = { ...baseFp, version: '1.0.0' };
    const next = { ...baseFp, version: '1.1.0', contract_schema_sha256: 'xyz' };
    expect(isViolation(prev, next)).toBe(false);
  });
});
