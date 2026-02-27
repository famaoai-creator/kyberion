import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, SpawnOptions } from 'node:child_process';
import * as pathResolver from '@agent/core/path-resolver';

export interface MissionContract {
  mission_id?: string;
  role?: string;
  skill: string;
  action: string;
  static_params?: Record<string, any>;
  safety_gate?: {
    risk_level?: number;
    require_sudo?: boolean;
    approved_by_sovereign?: boolean;
  };
  knowledge_injections?: string[];
}

export function executeCommand(
  cmd: string,
  args: string[],
  options: SpawnOptions,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`[MC] Executing: ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, options);

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += data;
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += data;
      });
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        const err = new Error(`Process exited with code ${code}`) as any;
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function orchestrate(contractPath: string, approved: boolean = false): Promise<any> {
  const resolvedContractPath = path.resolve(contractPath);
  if (!fs.existsSync(resolvedContractPath)) {
    throw new Error(`MissionContract not found: ${resolvedContractPath}`);
  }

  const contract = JSON.parse(safeReadFile(resolvedContractPath, 'utf8')) as MissionContract;
  const missionId = contract.mission_id || `mission-${Date.now()}`;
  const missionDir = pathResolver.missionDir(missionId);
  const evidenceDir = path.join(missionDir, 'evidence');
  if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });

  console.log(`[MC] Processing Mission: ${missionId}`);

  // 1. Safety Gate
  const safety = contract.safety_gate || {};
  if (((safety.risk_level && safety.risk_level >= 4) || safety.require_sudo) && !approved) {
    throw new Error(`SUDO_REQUIRED: Mission ${missionId} requires sovereign approval.`);
  }

  // 2. Resolve Skill
  const indexPath = path.join(process.cwd(), 'knowledge/orchestration/global_skill_index.json');
  const index = JSON.parse(safeReadFile(indexPath, 'utf8'));
  const skillMeta = index.s.find((s: any) => s.n === contract.skill);
  if (!skillMeta) {
    throw new Error(`SKILL_NOT_FOUND: ${contract.skill}`);
  }
  const scriptRelativePath = skillMeta.m || 'scripts/main.cjs';
  const skillScript = path.join(process.cwd(), contract.skill, scriptRelativePath);

  // 3. Execution Params
  const env = { ...process.env, MISSION_ID: missionId, MISSION_DIR: missionDir };
  let args = [skillScript];
  if (contract.action) args.push('--action', contract.action);

  const staticParams = contract.static_params || {};
  if (contract.skill === 'codebase-mapper' && staticParams.dirs) {
    args.push(...(staticParams.dirs as string[]));
    if (staticParams.depth) args.push('--depth', String(staticParams.depth));
  } else {
    const tempInput = path.join(evidenceDir, 'input_task.json');
    safeWriteFile(tempInput, JSON.stringify(staticParams, null, 2));
    args.push('--input', tempInput);
  }

  // 4. Async Execution
  try {
    const stdout = await executeCommand(
      'node',
      args,
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
      30000
    );

    const jsonStart = stdout.indexOf('{');
    if (jsonStart === -1) throw new Error('No JSON output found from skill execution');
    const outputJson = stdout.substring(jsonStart);

    safeWriteFile(path.join(evidenceDir, 'contract.json'), JSON.stringify(contract, null, 2));
    safeWriteFile(path.join(evidenceDir, 'output.json'), outputJson);

    console.log(`[MC] Mission ${missionId} completed.`);
    return JSON.parse(outputJson);
  } catch (err: any) {
    const errorMsg = `${err.message}
STDERR: ${err.stderr || ''}
STDOUT: ${err.stdout || ''}`;
    safeWriteFile(path.join(evidenceDir, 'error.log'), errorMsg);
    console.error(`[MC] Execution Failed: ${err.message}`);
    throw err;
  }
}
