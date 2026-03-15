import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { trustEngine } from './trust-engine.js';

describe('trust-engine', () => {
  it('initializes, records events, and computes execution rings', () => {
    const agentId = `agent-${Date.now()}-ring`;
    const record = trustEngine.initialize(agentId, 500);
    expect(record.score).toBe(500);
    expect(trustEngine.getRing(agentId)).toBe(2);

    trustEngine.recordEvent(agentId, 'outputQuality', 50, 'excellent output');
    const updated = trustEngine.getScore(agentId)!;
    expect(updated.score).toBeGreaterThan(500);
    expect(updated.tier).toMatch(/standard|trusted|verified/);
  });

  it('applies decay and propagates penalties', () => {
    const primaryId = `agent-${Date.now()}-primary`;
    const neighborId = `agent-${Date.now()}-neighbor`;

    trustEngine.initialize(primaryId, 800);
    trustEngine.initialize(neighborId, 700);

    const primary = trustEngine.getScore(primaryId)!;
    primary.lastUpdated = Date.now() - 3 * 3600000;

    trustEngine.applyDecay();
    expect(trustEngine.getScore(primaryId)!.score).toBeLessThan(800);

    const beforeNeighbor = trustEngine.getScore(neighborId)!.score;
    trustEngine.propagatePenalty(primaryId, 50, [neighborId]);
    expect(trustEngine.getScore(neighborId)!.score).toBeLessThan(beforeNeighbor);
  });

  it('detects regime shifts from divergent recent history', () => {
    const agentId = `agent-${Date.now()}-shift`;
    trustEngine.initialize(agentId, 500);
    const record = trustEngine.getScore(agentId)!;
    record.history = [
      { ts: 1, score: 500, event: 'a' },
      { ts: 2, score: 505, event: 'b' },
      { ts: 3, score: 510, event: 'c' },
      { ts: 4, score: 495, event: 'd' },
      { ts: 5, score: 500, event: 'e' },
      { ts: 6, score: 498, event: 'f' },
      { ts: 7, score: 502, event: 'g' },
      { ts: 8, score: 501, event: 'h' },
      { ts: 9, score: 780, event: 'i' },
      { ts: 10, score: 790, event: 'j' },
      { ts: 11, score: 800, event: 'k' },
      { ts: 12, score: 810, event: 'l' },
      { ts: 13, score: 820, event: 'm' },
    ];

    const result = trustEngine.detectRegimeShift(agentId);
    expect(result.shifted).toBe(true);
    expect(result.divergence).toBeGreaterThan(0.5);
  });

  it('persists and reloads trust records from an explicit root', () => {
    const agentId = `agent-${Date.now()}-persist`;
    trustEngine.initialize(agentId, 650);
    trustEngine.recordEvent(agentId, 'policyCompliance', 10, 'compliant');

    const tempRoot = path.join(process.cwd(), 'active/shared/tmp', `kyberion-trust-${Date.now()}`);
    const governanceDir = path.join(tempRoot, 'knowledge', 'personal', 'governance');
    fs.mkdirSync(governanceDir, { recursive: true });

    trustEngine.persist(tempRoot);
    const persistedPath = path.join(governanceDir, 'agent-trust-scores.json');
    const persisted = JSON.parse(fs.readFileSync(persistedPath, 'utf8'));
    expect(persisted[agentId].current_score).toBe(trustEngine.getScore(agentId)!.score);

    const reloadedAgentId = `agent-${Date.now()}-reload`;
    persisted[reloadedAgentId] = {
      current_score: 930,
      tier: 'verified',
      dimensions: {
        policyCompliance: 190,
        securityPosture: 190,
        outputQuality: 190,
        resourceEfficiency: 180,
        collaborationHealth: 180,
      },
      last_updated: new Date().toISOString(),
    };
    fs.writeFileSync(persistedPath, JSON.stringify(persisted, null, 2));

    trustEngine.loadPersisted(tempRoot);
    expect(trustEngine.getScore(reloadedAgentId)?.score).toBe(930);
    expect(trustEngine.getRing(reloadedAgentId)).toBe(1);
  });
});
