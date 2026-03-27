import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { 
  rootDir, 
  missionDir, 
  missionEvidenceDir, 
  findMissionPath,
  ledger,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync
} from '@agent/core';
import { detectTier } from '@agent/core/governance';

describe('Tiered Mission Architecture', () => {
  const TEST_MISSION_ID = 'TEST-MSN-TIER-999';
  const PROJECT_ROOT = rootDir();

  beforeEach(() => {
    process.env.MISSION_ROLE = 'mission_controller';
  });

  it('should detect tiers correctly based on paths', () => {
    expect(detectTier('knowledge/personal/identity.json')).toBe('personal');
    expect(detectTier('knowledge/confidential/project.md')).toBe('confidential');
    expect(detectTier('knowledge/public/protocol.md')).toBe('public');
    expect(detectTier('readme.md')).toBe('public');
  });

  it('should resolve tiered mission directories correctly', () => {
    const personalDir = missionDir(TEST_MISSION_ID, 'personal');
    expect(personalDir).toBe(path.join(PROJECT_ROOT, 'knowledge/personal/missions', TEST_MISSION_ID));

    const confidentialDir = missionDir(TEST_MISSION_ID, 'confidential');
    expect(confidentialDir).toBe(path.join(PROJECT_ROOT, 'active/missions/confidential', TEST_MISSION_ID));

    const publicDir = missionDir(TEST_MISSION_ID, 'public');
    expect(publicDir).toBe(path.join(PROJECT_ROOT, 'active/missions/public', TEST_MISSION_ID));
  });

  it('should find mission path across all tiers', () => {
    // Manually create a mission dir in personal tier for testing findMissionPath
    const personalMissionPath = path.join(PROJECT_ROOT, 'knowledge/personal/missions', TEST_MISSION_ID);
    if (!safeExistsSync(personalMissionPath)) safeMkdir(personalMissionPath, { recursive: true });
    
    const foundPath = findMissionPath(TEST_MISSION_ID);
    expect(foundPath).toBe(personalMissionPath);
    
    // Cleanup
    safeRmSync(personalMissionPath, { recursive: true, force: true });
  });

  it('should record hybrid ledger entries correctly', () => {
    const missionId = 'LEDGER-TEST-001';
    const missionPath = missionDir(missionId, 'confidential');
    const missionLedgerPath = path.join(missionPath, 'evidence/ledger.jsonl');
    const globalLedgerPath = path.join(PROJECT_ROOT, 'active/audit/system-ledger.jsonl');

    // Record a mission event
    ledger.record('TEST_EVENT', { 
      mission_id: missionId, 
      role: 'Tester',
      secret_data: 'DO_NOT_SHOW_IN_GLOBAL' 
    });

    // 1. Check Mission Ledger (Should have details)
    expect(safeExistsSync(missionLedgerPath)).toBe(true);
    const missionContent = safeReadFile(missionLedgerPath, { encoding: 'utf8' }) as string;
    expect(missionContent).toContain('DO_NOT_SHOW_IN_GLOBAL');
    expect(missionContent).toContain('TEST_EVENT');

    // 2. Check Global Ledger (Should have metadata only)
    expect(safeExistsSync(globalLedgerPath)).toBe(true);
    const globalContent = safeReadFile(globalLedgerPath, { encoding: 'utf8' }) as string;
    expect(globalContent).toContain('MISSION_EVENT:TEST_EVENT');
    expect(globalContent).not.toContain('DO_NOT_SHOW_IN_GLOBAL');
    expect(globalContent).toContain('Metadata only');

    // Cleanup
    safeRmSync(missionPath, { recursive: true, force: true });
  });
});
