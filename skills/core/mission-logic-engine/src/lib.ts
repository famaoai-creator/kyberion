import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';

/**
 * Mission Logic Engine Core Library.
 * Reflexive execution engine for established mission logic.
 */

export interface MissionContract {
  skill: string;
  action?: string;
  args?: string;
  safety_gate?: {
    require_sudo?: boolean;
  };
}

export async function orchestrate(contractPath: string, approved: boolean = false): Promise<any> {
  if (!fs.existsSync(contractPath)) {
    throw new Error(`MissionContract not found: ${contractPath}`);
  }

  const content = safeReadFile(contractPath, { encoding: 'utf8' }) as string;
  const contract = JSON.parse(content) as MissionContract;

  // 1. Safety Check
  if (contract.safety_gate?.require_sudo && !approved) {
    throw new Error('SUDO_REQUIRED: This mission requires explicit approval.');
  }

  // 2. Resolve Skill
  const indexPath = pathResolver.knowledge('orchestration/global_skill_index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error('Skill index not found.');
  }

  const index = JSON.parse(safeReadFile(indexPath, { encoding: 'utf8' }) as string);
  const skillMeta = index.s.find((s: any) => s.n === contract.skill);
  if (!skillMeta) {
    throw new Error(`SKILL_NOT_FOUND: ${contract.skill}`);
  }

  const scriptRelativePath = skillMeta.m || 'dist/index.js';
  const skillScript = path.join(process.cwd(), skillMeta.path || contract.skill, scriptRelativePath);

  // 3. Execution
  const missionId = process.env.MISSION_ID || `MSN-${Date.now()}`;
  const currentMissionDir = pathResolver.missionDir(missionId);
  const evidenceDir = path.join(currentMissionDir, 'evidence');
  if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });

  const cmd = `node "${skillScript}" ${contract.args || ''}`;
  
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: { ...process.env, MISSION_ID: missionId, MISSION_DIR: currentMissionDir }
    });

    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      data = { raw: stdout.trim() };
    }

    const report = {
      missionId,
      status: 'success',
      skill: contract.skill,
      action: contract.action,
      timestamp: new Date().toISOString(),
      data
    };

    safeWriteFile(path.join(currentMissionDir, 'ace-report.json'), JSON.stringify(report, null, 2));
    return report;
  } catch (err: any) {
    const errorMsg = `${err.message}\nSTDERR: ${err.stderr || ''}\nSTDOUT: ${err.stdout || ''}`;
    safeWriteFile(path.join(evidenceDir, 'error.log'), errorMsg);
    throw err;
  }
}
