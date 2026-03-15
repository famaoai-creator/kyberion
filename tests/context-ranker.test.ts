import { describe, it, expect } from 'vitest';
import { parseFrontmatter, tokenize, scoreEntry } from '../scripts/context_ranker.js';
import type { KnowledgeEntry, RankingWeights } from '../scripts/context_ranker.js';

describe('Context Ranker — parseFrontmatter', () => {
  it('parses standard YAML frontmatter', () => {
    const content = `---
title: My Document
importance: 5
tags: [governance, mission]
kind: governance
scope: repository
authority: policy
phase: [alignment, execution]
---
Body text here.`;
    const result = parseFrontmatter(content);
    expect(result.title).toBe('My Document');
    expect(result.importance).toBe(5);
    expect(result.tags).toEqual(['governance', 'mission']);
    expect(result.kind).toBe('governance');
    expect(result.scope).toBe('repository');
    expect(result.phase).toEqual(['alignment', 'execution']);
  });

  it('returns empty object when no frontmatter present', () => {
    const content = 'Just plain text without frontmatter.';
    const result = parseFrontmatter(content);
    expect(result).toEqual({});
  });

  it('handles frontmatter with no array values', () => {
    const content = `---
title: Simple
importance: 3
---`;
    const result = parseFrontmatter(content);
    expect(result.title).toBe('Simple');
    expect(result.importance).toBe(3);
  });
});

describe('Context Ranker — tokenize', () => {
  it('splits text on whitespace and delimiters', () => {
    const tokens = tokenize('mission-governance v2');
    expect(tokens).toContain('mission');
    expect(tokens).toContain('governance');
    expect(tokens).toContain('v2');
  });

  it('lowercases tokens', () => {
    const tokens = tokenize('Mission CONTROL');
    expect(tokens).toContain('mission');
    expect(tokens).toContain('control');
  });

  it('filters out single-character tokens', () => {
    const tokens = tokenize('a big test');
    expect(tokens).not.toContain('a');
    expect(tokens).toContain('big');
    expect(tokens).toContain('test');
  });
});

describe('Context Ranker — scoreEntry', () => {
  const weights: RankingWeights = { title: 10, id: 5, tag: 15, category: 3, role: 25, phase: 18, scope: 12, kind: 10, authority: 8 };
  const now = new Date('2025-06-01').getTime();

  const baseEntry: KnowledgeEntry = {
    path: 'public/governance/mission-lifecycle.md',
    title: 'Mission Lifecycle',
    tags: ['governance', 'mission'],
    importance: 5,
    related_roles: ['ecosystem_architect'],
    role_affinity: ['mission_controller'],
    last_updated: '2025-05-01',
    tier: 'public',
    kind: 'governance',
    scope: 'repository',
    authority: 'policy',
    phase: ['alignment', 'execution'],
    applies_to: ['missions'],
  };

  it('scores higher when intent matches title', () => {
    const scored = scoreEntry(baseEntry, ['mission'], '', '', 'repository', weights, now);
    expect(scored.breakdown.intent).toBeGreaterThan(0);
    expect(scored.score).toBeGreaterThan(0);
  });

  it('scores higher when role matches', () => {
    const scored = scoreEntry(baseEntry, ['mission'], 'ecosystem_architect', '', 'repository', weights, now);
    expect(scored.breakdown.role).toBe(25);
  });

  it('role score is 0 when role does not match', () => {
    const scored = scoreEntry(baseEntry, ['mission'], 'unknown_role', '', 'repository', weights, now);
    expect(scored.breakdown.role).toBe(0);
  });

  it('adds phase, scope, kind, and authority score for aligned execution context', () => {
    const scored = scoreEntry(baseEntry, ['mission'], 'ecosystem_architect', 'alignment', 'repository', weights, now);
    expect(scored.breakdown.phase).toBeGreaterThan(0);
    expect(scored.breakdown.scope).toBeGreaterThan(0);
    expect(scored.breakdown.kind).toBeGreaterThan(0);
    expect(scored.breakdown.authority).toBeGreaterThan(0);
  });

  it('recency score decreases with age', () => {
    const recent = scoreEntry(baseEntry, ['mission'], '', '', 'repository', weights, now);
    const oldEntry = { ...baseEntry, last_updated: '2020-01-01' };
    const old = scoreEntry(oldEntry, ['mission'], '', '', 'repository', weights, now);
    expect(recent.breakdown.recency).toBeGreaterThan(old.breakdown.recency);
  });
});
