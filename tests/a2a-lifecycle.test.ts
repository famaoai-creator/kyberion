import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { safeExec, safeExistsSync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Change knowledge root to a temporary test directory
const TEST_KNOWLEDGE_ROOT = path.join(process.cwd(), 'active', 'shared', 'tmp', 'test-knowledge');
process.env.KYBERION_KNOWLEDGE_ROOT = TEST_KNOWLEDGE_ROOT;

const AGENT_ID = 'Test-Agent-X';
const LEDGER_PATH = pathResolver.knowledge('personal/governance/agent-trust-scores.json');
const RUN_ID = Date.now();
// KYBERION_KNOWLEDGE_ROOT above does not move pathResolver.knowledge(), so the
// verify flow writes the LIVE trust ledger. Snapshot it and restore it in
// afterAll so a run neither leaves fixture agents in it nor creates it.
const LEDGER_DIR_EXISTED = fs.existsSync(path.dirname(LEDGER_PATH));
const LEDGER_BEFORE = fs.existsSync(LEDGER_PATH) ? fs.readFileSync(LEDGER_PATH, 'utf8') : null;

// KP-07 (knowledge-store hygiene): mission_controller's checkPrerequisites()
// gates mission creation on a full "sovereign profile" (my-identity.json +
// my-vision.md + agent-identity.json) resolved via resolveActiveProfileRoot()
// (scripts/refactor/mission-state.ts). That resolver honors KYBERION_CUSTOMER
// as a profile-root override (libs/core/customer-resolver.ts: customerRoot()),
// so this suite points the gate at an isolated `customer/{slug}/` overlay
// instead of writing fixture identity content into the real
// knowledge/personal/ tier — writing there was the root cause of
// knowledge/personal/my-identity.json being clobbered with `{"sovereign":
// "test", ...}` on every full test-suite run (KM-04 persistent-tier
// pollution). runMissionController() forwards this env var to the
// mission_controller.js subprocess via `env: { ...process.env, ... }`.
// The overlay slug is now validated as a tenant slug (TENANT_SLUG_PATTERN,
// max 31 chars); `a2a-lifecycle-test-<ms epoch>` was 32 and mission start
// aborted with [COMPANY_TENANT_SCOPE] invalid tenant slug. Base36 keeps the
// per-run uniqueness inside the limit.
const CUSTOMER_SLUG = `a2a-life-${RUN_ID.toString(36)}`;
process.env.KYBERION_CUSTOMER = CUSTOMER_SLUG;
const PROFILE_ROOT = path.join(process.cwd(), 'customer', CUSTOMER_SLUG);
const IDENTITY_PATH = path.join(PROFILE_ROOT, 'my-identity.json');

function ensurePersonalFixtures() {
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(
    IDENTITY_PATH,
    JSON.stringify({ sovereign: 'test', initialized_at: new Date().toISOString() }, null, 2)
  );
  // mission_controller start gates on the FULL sovereign profile
  // (my-identity.json + my-vision.md + agent-identity.json) — a dev box has
  // them from onboarding, a fresh CI checkout does not.
  fs.writeFileSync(
    path.join(PROFILE_ROOT, 'my-vision.md'),
    '# Sovereign Vision\n\nTest fixture vision.\n'
  );
  fs.writeFileSync(
    path.join(PROFILE_ROOT, 'agent-identity.json'),
    JSON.stringify({ agent_id: 'test-agent', version: '1.0.0', trust_tier: 'sovereign' }, null, 2)
  );
  if (!safeExistsSync(LEDGER_PATH)) fs.writeFileSync(LEDGER_PATH, JSON.stringify({}, null, 2));
}

// This suite is an end-to-end test of the mission_controller CLI, so each
// step is a real child process (11 per run). Measured (operations-hygiene-
// runbook §5): a cold `start` child takes ~6.5s at load 5 and 30s+ at load
// ~25-35 on 4 cores (node start-up, the 90k-line bundle, local STT probes, an
// intent-contract grandchild, the mission micro-repo); delegate/verify/cancel
// take ~2s idle. The child budget and the per-scenario budget (4-5 children)
// are sized for that load: the 30s safeExec default killed `start` mid-write
// and left a writer-lease lock behind.
const CHILD_TIMEOUT_MS = 120_000;
const SUITE_OPTIONS = { concurrent: false, timeout: 300_000 };

function runMissionController(...args: string[]) {
  ensurePersonalFixtures();
  return safeExec('node', ['dist/scripts/mission_controller.js', ...args], {
    // `stub` keeps the controller's reasoning bootstrap off the host's
    // provider CLIs: under load the `start` child spent seconds probing them
    // (`claude auth status` alone took 2.7-4.9s at load 24), and the
    // trust-ledger flow under test never reaches a reasoning backend.
    env: { ...process.env, MISSION_ROLE: 'mission_controller', KYBERION_REASONING_BACKEND: 'stub' },
    timeoutMs: CHILD_TIMEOUT_MS,
  });
}

function readLedger(): Record<string, any> {
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
}

describe('A2A Mission Lifecycle & Trust Engine Integration', SUITE_OPTIONS, () => {
  beforeAll(() => {
    process.env.MISSION_ROLE = 'mission_controller';
    ensurePersonalFixtures();
  });

  afterAll(() => {
    if (LEDGER_BEFORE !== null) fs.writeFileSync(LEDGER_PATH, LEDGER_BEFORE);
    else if (!LEDGER_DIR_EXISTED)
      fs.rmSync(path.dirname(LEDGER_PATH), { recursive: true, force: true });
    else fs.rmSync(LEDGER_PATH, { force: true });
    fs.rmSync(TEST_KNOWLEDGE_ROOT, { recursive: true, force: true });
    // KP-07: remove the isolated customer overlay used for the sovereign
    // profile gate (see CUSTOMER_SLUG above) and restore the env var so it
    // never leaks into other test files sharing this worker process.
    fs.rmSync(PROFILE_ROOT, { recursive: true, force: true });
    delete process.env.KYBERION_CUSTOMER;
    // Missions created via the real mission_controller land in the REAL
    // personal missions tier — remove this run's fixtures so test debris does
    // not accumulate in the operator home view.
    for (const root of [
      pathResolver.knowledge('personal/missions'),
      path.join(process.cwd(), 'active', 'archive', 'missions'),
    ]) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        if (entry.includes(`-${RUN_ID}`) && entry.startsWith('MSN-TEST-LIFE-')) {
          fs.rmSync(path.join(root, entry), { recursive: true, force: true });
        }
      }
    }
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
    runMissionController('cancel', missionId, 'cleanup after verification flow');
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

    runMissionController('cancel', FAIL_MISSION_ID, 'cleanup after rejection flow');
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

    runMissionController('cancel', GUARD_MISSION_ID, 'cleanup after trust guardrail flow');
  });
});
