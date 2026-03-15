import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { safeExec, safeExistsSync, pathResolver } from '../libs/core/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const AGENT_ID = 'Test-Agent-X';
const LEDGER_PATH = pathResolver.knowledge('personal/governance/agent-trust-scores.json');
const IDENTITY_PATH = pathResolver.knowledge('personal/my-identity.json');
const RUN_ID = Date.now();

function ensurePersonalFixtures() {
  fs.mkdirSync(path.dirname(IDENTITY_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify({ sovereign: 'test', initialized_at: new Date().toISOString() }, null, 2));
  if (!safeExistsSync(LEDGER_PATH)) fs.writeFileSync(LEDGER_PATH, JSON.stringify({}, null, 2));
}

function runMissionController(...args: string[]) {
  ensurePersonalFixtures();
  return safeExec('node', ['--import', 'tsx', 'scripts/mission_controller.ts', ...args], {
    env: { ...process.env, MISSION_ROLE: 'mission_controller' },
  });
}

function readLedger(): Record<string, any> {
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
}

describe.sequential('A2A Mission Lifecycle & Trust Engine Integration', () => {
  
  beforeAll(() => {
    process.env.MISSION_ROLE = 'mission_controller';
    ensurePersonalFixtures();
  });

  beforeEach(() => {
    ensurePersonalFixtures();
    const ledger = readLedger();
    delete ledger[AGENT_ID];
    delete ledger['Agent-Bad'];
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  });

  it('Scenario 1: Full Success Flow (Verified & Score Increase)', async () => {
    const missionId = `MSN-TEST-LIFE-A2A-${RUN_ID}`;
    // 1. Create Mission
    runMissionController('start', missionId, 'personal');
    
    // 2. Delegate
    runMissionController('delegate', missionId, AGENT_ID, 'MSG-SUCCESS');
    
    // 3. Verify
    runMissionController('verify', missionId, 'verified', 'Good work');
    
    // 4. Check Score
    const ledger = readLedger();
    expect(ledger[AGENT_ID].current_score).toBe(515);
    
    // Cleanup for next test
    runMissionController('finish', missionId);
  });

  it('Scenario 2: Failure Flow (Rejected & Score Decrease)', async () => {
    const FAIL_MISSION_ID = `MSN-TEST-LIFE-FAIL-${RUN_ID}`;
    
    // 1. Create and Delegate
    runMissionController('start', FAIL_MISSION_ID, 'personal');
    runMissionController('delegate', FAIL_MISSION_ID, AGENT_ID, 'MSG-FAIL');
    
    // 2. Verify with Rejection
    runMissionController('verify', FAIL_MISSION_ID, 'rejected', 'Poor work');
    
    // 3. Check Score after one rejection from the default baseline
    const ledger = readLedger();
    expect(ledger[AGENT_ID].current_score).toBe(480);
    
    runMissionController('finish', FAIL_MISSION_ID);
  });

  it('Scenario 3: Trust Guardrail (Insufficient Score)', async () => {
    const GUARD_MISSION_ID = `MSN-TEST-LIFE-GUARD-${RUN_ID}`;
    const LOW_TRUST_AGENT = 'Agent-Bad';

    // 1. Manually set a low score
    const ledger = readLedger();
    ledger[LOW_TRUST_AGENT] = {
      current_score: 200,
      tier: 3,
      dimensions: {
        policyCompliance: 40,
        securityPosture: 40,
        outputQuality: 40,
        resourceEfficiency: 40,
        collaborationHealth: 40,
      },
      last_updated: new Date().toISOString(),
    };
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));

    // 2. Try to delegate a personal mission (Should fail)
    runMissionController('start', GUARD_MISSION_ID, 'personal');
    
    try {
      runMissionController('delegate', GUARD_MISSION_ID, LOW_TRUST_AGENT, 'MSG-X');
      throw new Error('Should have failed due to low trust');
    } catch (err: any) {
      expect(err.message).toContain('insufficient trust score');
    }

    runMissionController('finish', GUARD_MISSION_ID);
  });
});
