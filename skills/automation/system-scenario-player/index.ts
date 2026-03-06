import { logger, runSkillAsync } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeExec } from '@agent/core/secure-io';
import * as fs from 'node:fs';

/**
 * system-scenario-player v1.0 (Brain Orchestrator)
 * Executes automation scenarios by chaining muscle skills.
 */

interface ScenarioStep {
  type: 'keyboard' | 'mouse' | 'wait' | 'shell' | 'visual_wait' | 'screenshot';
  params?: any;
  ms?: number;
}

interface PlayerArgs {
  scenario?: ScenarioStep[];
  speed?: number;
  input?: string;
}

async function executeStep(step: ScenarioStep, speed: number) {
  logger.info(`🎬 Step: ${step.type}...`);

  switch (step.type) {
    case 'keyboard':
      await safeExec('node', ['dist/scripts/cli.js', 'run', 'keyboard-injector', ...objectToArgs(step.params)]);
      break;
    case 'mouse':
      await safeExec('node', ['dist/scripts/cli.js', 'run', 'mouse-injector', ...objectToArgs(step.params)]);
      break;
    case 'wait':
      const waitMs = (step.ms || 1000) / speed;
      await new Promise(r => setTimeout(r, waitMs));
      break;
    case 'visual_wait':
      await safeExec('node', ['dist/scripts/cli.js', 'run', 'visual-assertion-engine', ...objectToArgs(step.params)]);
      break;
    case 'screenshot':
      await safeExec('node', ['dist/scripts/cli.js', 'run', 'visual-evidence-generator', ...objectToArgs(step.params)]);
      break;
    case 'shell':
      await safeExec(step.params.command, step.params.args || []);
      break;
    default:
      logger.warn(`⚠️ Unknown step type: ${step.type}`);
  }
}

function objectToArgs(obj: any): string[] {
  if (!obj) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    args.push(`--${key}`);
    if (Array.isArray(value)) {
      args.push(JSON.stringify(value));
    } else {
      args.push(String(value));
    }
  }
  return args;
}

const main = async (args: PlayerArgs) => {
  let effectiveScenario = args.scenario;
  let speed = args.speed || 1.0;

  if (args.input && fs.existsSync(args.input)) {
    const fileData = JSON.parse(fs.readFileSync(args.input, 'utf8'));
    if (Array.isArray(fileData)) {
      effectiveScenario = fileData;
    } else {
      effectiveScenario = fileData.scenario;
      speed = fileData.speed || speed;
    }
  }

  if (!effectiveScenario || !Array.isArray(effectiveScenario)) {
    throw new Error('A valid scenario (array of steps) is required via --scenario or --input.');
  }

  logger.info(`🧠 Starting system scenario (${effectiveScenario.length} steps, speed: ${speed}x)`);

  for (const step of effectiveScenario) {
    try {
      await executeStep(step, speed);
    } catch (err: any) {
      logger.error(`❌ Scenario execution halted at step: ${step.type}. Error: ${err.message}`);
      throw err;
    }
  }

  return {
    status: 'success',
    message: 'System scenario completed successfully.',
    steps_executed: effectiveScenario.length
  };
};

const argv = createStandardYargs()
  .option('scenario', { type: 'array' })
  .option('speed', { type: 'number' })
  .option('input', { type: 'string' })
  .parseSync();

runSkillAsync('system-scenario-player', () => main(argv as any));
