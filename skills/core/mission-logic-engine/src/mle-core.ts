import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { logger, safeWriteFile } from '@agent/core';
import { resolveSkillScript } from '@agent/core/orchestrator';

export interface MLEOptions {
  pipelinePath: string;
  missionId: string;
  vars: Record<string, any>;
  signalDir?: string;
}

export function interpolate(template: string, vars: Record<string, any>): string {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    if (vars[key] === undefined) {
      // Allow {{last_output}} to be resolved later
      if (key === 'last_output') return '{{last_output}}';
      throw new Error(`MLE variable "{{${key}}}" has no value.`);
    }
    return String(vars[key]);
  });
}

export async function executeMLE(options: MLEOptions): Promise<any> {
  const { pipelinePath, missionId, vars, signalDir } = options;
  const rootDir = process.cwd();
  
  if (!fs.existsSync(pipelinePath)) {
    throw new Error(`Pipeline not found: ${pipelinePath}`);
  }

  const pipelineDef: any = yaml.load(fs.readFileSync(pipelinePath, 'utf8'));
  const steps = pipelineDef.steps || [];
  const results: any[] = [];
  let lastOutput: any = null;

  const actualSignalDir = signalDir || path.join(rootDir, 'active/missions', missionId, 'signals');
  if (!fs.existsSync(actualSignalDir)) fs.mkdirSync(actualSignalDir, { recursive: true });

  logger.info(`[MLE] Starting Pipeline: ${pipelineDef.name || 'Untitled'}`);

  for (const step of steps) {
    const stepId = step.id || step.skill;
    logger.info(`[MLE] Executing Step: ${stepId}`);

    // Prepare variables for this step
    const currentVars = { ...vars, last_output: lastOutput };
    
    const skillName = step.skill;
    const scriptPath = resolveSkillScript(skillName);
    const args = step.args ? interpolate(step.args, currentVars) : '';
    
    const cmd = `node "${scriptPath}" ${args}`;
    
    try {
      const stdout = execSync(cmd, { 
        encoding: 'utf8', 
        cwd: rootDir,
        env: { ...process.env, MISSION_ID: missionId }
      });

      try {
        lastOutput = JSON.parse(stdout);
      } catch {
        lastOutput = stdout.trim();
      }

      results.push({ id: stepId, status: 'success', output: lastOutput });
    } catch (err: any) {
      logger.error(`[MLE] Step Failed: ${stepId}`);
      
      const signal = {
        missionId,
        stepId,
        skill: skillName,
        error: err.message,
        stderr: err.stderr?.toString(),
        timestamp: new Date().toISOString(),
        suggest_intervention: true
      };

      const signalPath = path.join(actualSignalDir, `failure_${stepId}.json`);
      safeWriteFile(signalPath, JSON.stringify(signal, null, 2));
      
      logger.warn(`[MLE] Signal emitted: ${signalPath}`);
      
      return {
        status: 'interrupted',
        failed_step: stepId,
        signal_path: signalPath,
        completed_steps: results
      };
    }
  }

  return {
    status: 'completed',
    pipeline: pipelineDef.name,
    steps: results
  };
}
