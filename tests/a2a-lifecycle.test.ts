import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { safeExec, safeReadFile, safeExistsSync, pathResolver } from '../libs/core/index.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

const ROOT_DIR = pathResolver.rootDir();
const TEST_MISSION_ID = 'MSN-TEST-LIFE-A2A';
const AGENT_ID = 'Test-Agent-X';
const LEDGER_PATH = path.join(ROOT_DIR, 'knowledge/personal/governance/agent-trust-scores.json');

describe('A2A Mission Lifecycle & Trust Engine Integration', () => {
  
  beforeAll(() => {
    // Ensure we start with a clean slate for the test agent
    if (safeExistsSync(LEDGER_PATH)) {
      const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      delete ledger.agents[AGENT_ID];
      fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
    }
  });

  it('Scenario 1: Full Success Flow (Verified & Score Increase)', async () => {
    // 1. Create Mission
    safeExec('npx', ['tsx', 'scripts/mission_controller.ts', 'start', TEST_MISSION_ID, 'personal']);
    
    // 2. Delegate
    safeExec('npx', ['tsx', 'scripts/mission_controller.ts', 'delegate', TEST_MISSION_ID, AGENT_ID, 'MSG-SUCCESS']);
    
    // 3. Verify
    safeExec('npx', ['tsx', 'scripts/mission_controller.ts', 'verify', TEST_MISSION_ID, 'verified', 'Good work']);
    
    // 4. Check Score
    const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    expect(ledger.agents[AGENT_ID].current_score).toBe(5.5);
    expect(ledger.agents[AGENT_ID].total_missions).toBe(1);
    
    // Cleanup for next test
    safeExec('npx', ['tsx', 'scripts/mission_controller.ts', 'finish', TEST_MISSION_ID]);
  });

  it('Scenario 2: Failure Flow (Rejected & Score Decrease)', async () => {
    const FAIL_MISSION_ID = 'MSN-TEST-LIFE-FAIL';
    
    // 1. Create and Delegate
    safeExec('npx', ['tsx', 'scripts/mission_controller.ts', 'start', FAIL_MISSION_ID, 'personal']);
    safeExec('npx', ['tsx', 'scripts/mission_controller.ts', 'delegate', FAIL_MISSION_ID, AGENT_ID, 'MSG-FAIL']);
    
    // 2. Verify with Rejection
    safeExec('npx', ['tsx', 'scripts/mission_controller.ts', 'verify', FAIL_MISSION_ID, 'rejected', 'Poor work']);
    
    // 3. Check Score (5.5 - 1.0 = 4.5)
    const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    expect(ledger.agents[AGENT_ID].current_score).toBe(4.5);
    
    safeExec('npx', ['tsx', 'scripts/mission_controller.ts', 'finish', FAIL_MISSION_ID]);
  });

  it('Scenario 3: Trust Guardrail (Insufficient Score)', async () => {
    const GUARD_MISSION_ID = 'MSN-TEST-LIFE-GUARD';
    const LOW_TRUST_AGENT = 'Agent-Bad';

    // 1. Manually set a low score
    const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    ledger.agents[LOW_TRUST_AGENT] = {
      current_score: 2.0,
      total_missions: 0,
      success_rate: 0,
      performance: { consecutive_successes: 0 },
      history: []
    };
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));

    // 2. Try to delegate a personal mission (Should fail)
    safeExec('npx', ['tsx', 'scripts/mission_controller.ts', 'start', GUARD_MISSION_ID, 'personal']);
    
    try {
      safeExec('npx', ['tsx', 'scripts/mission_controller.ts', 'delegate', GUARD_MISSION_ID, LOW_TRUST_AGENT, 'MSG-X']);
      throw new Error('Should have failed due to low trust');
    } catch (err: any) {
      expect(err.message).toContain('insufficient trust score');
    }

    safeExec('npx', ['tsx', 'scripts/mission_controller.ts', 'finish', GUARD_MISSION_ID]);
  });
});
