import { logger, safeReadFile, safeWriteFile, safeExec } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import yaml from 'js-yaml';

/**
 * Orchestrator-Actuator v1.2.0 [SECURE-IO ENFORCED]
 * Strictly compliant with Layer 2 (Shield).
 * Unified Mission & Task Management logic.
 */

interface OrchestratorAction {
  action: 'execute' | 'heal' | 'checkpoint' | 'verify_alignment' | 'materialize' | 'import_mission' | 'export_mission' | 'generate_pr' | 'run_tasks';
  pipeline_path?: string;
  mission_id?: string;
  blueprint_path?: string; // for 'materialize' action
  mep_path?: string; // for 'import_mission'
  output_file?: string; // for 'export_mission'
  include_evidence?: boolean; // for 'export_mission'
  persona?: string; // for 'run_tasks'
}

async function handleAction(input: OrchestratorAction) {
  const missionId = input.mission_id || `MSN-${Date.now()}`;

  switch (input.action) {
    case 'execute':
      if (!input.pipeline_path) throw new Error('pipeline_path required');
      const pipelineContent = safeReadFile(input.pipeline_path, { encoding: 'utf8' }) as string;
      const pipeline = yaml.load(pipelineContent);
      return { status: 'executing', missionId, steps: (pipeline as any).steps?.length };

    case 'checkpoint':
      safeExec('git', ['add', '.']);
      safeExec('git', ['commit', '-m', `checkpoint(${missionId}): Secure State Preservation`]);
      return { status: 'checkpoint_created' };

    case 'materialize':
      return await performMaterialize(input);

    case 'import_mission':
      return await performImport(input);

    case 'export_mission':
      return await performExport(input);

    case 'generate_pr':
      return await performGeneratePR(input);

    case 'run_tasks':
      return await performRunTasks(input);

    default:
      return { status: 'idle' };
  }
}

async function performImport(input: OrchestratorAction) {
  const { mep_path: mepPath, mission_id: targetMissionId } = input;
  if (!mepPath || !targetMissionId) throw new Error('mep_path and mission_id are required for import_mission');

  const mepContent = safeReadFile(path.resolve(process.cwd(), mepPath), { encoding: 'utf8' }) as string;
  const mep = JSON.parse(mepContent);
  const targetPath = path.resolve(process.cwd(), 'active/missions', targetMissionId);

  if (fs.existsSync(targetPath)) throw new Error(`Mission directory already exists: ${targetMissionId}`);

  fs.mkdirSync(targetPath, { recursive: true });
  fs.mkdirSync(path.join(targetPath, 'evidence'), { recursive: true });

  const REHYDRATE_MAP: Record<string, string> = {
    '{{HOME}}': process.env.HOME || '/Users',
    '{{PROJECT_ROOT}}': process.cwd(),
  };

  const rehydrate = (content: string) => {
    let rehydrated = content;
    for (const [key, value] of Object.entries(REHYDRATE_MAP)) {
      rehydrated = rehydrated.split(key).join(value);
    }
    return rehydrated;
  };

  if (mep.blueprint.contract) {
    const contract = JSON.parse(rehydrate(JSON.stringify(mep.blueprint.contract)));
    contract.id = targetMissionId;
    safeWriteFile(path.join(targetPath, 'contract.json'), JSON.stringify(contract, null, 2));
  }

  if (mep.blueprint.procedure) {
    safeWriteFile(path.join(targetPath, 'TASK_BOARD.md'), rehydrate(mep.blueprint.procedure));
  }

  if (mep.evidence && Array.isArray(mep.evidence)) {
    for (const ev of mep.evidence) {
      const evContent = typeof ev.content === 'object' ? JSON.stringify(ev.content, null, 2) : ev.content;
      safeWriteFile(path.join(targetPath, 'evidence', ev.name), rehydrate(evContent));
    }
  }

  return { status: 'success', mission_id: targetMissionId, path: targetPath };
}

async function performExport(input: OrchestratorAction) {
  const { mission_id: missionId, include_evidence: includeEvidence, output_file: outputFile } = input;
  if (!missionId) throw new Error('mission_id is required for export_mission');

  const missionPath = path.resolve(process.cwd(), 'active/missions', missionId);
  if (!fs.existsSync(missionPath)) throw new Error(`Mission not found: ${missionId}`);

  const mep: any = {
    version: '0.1.0',
    exportedAt: new Date().toISOString(),
    missionId,
    blueprint: {},
    evidence: []
  };

  const SANITIZE_MAP: Record<string, string> = {
    [process.env.HOME || '/Users']: '{{HOME}}',
    [process.cwd()]: '{{PROJECT_ROOT}}',
  };

  const sanitize = (content: string) => {
    let sanitized = content;
    for (const [key, value] of Object.entries(SANITIZE_MAP)) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sanitized = sanitized.replace(new RegExp(escapedKey, 'g'), value);
    }
    return sanitized;
  };

  const contractPath = path.join(missionPath, 'contract.json');
  if (fs.existsSync(contractPath)) {
    const contract = JSON.parse(safeReadFile(contractPath, { encoding: 'utf8' }) as string);
    mep.blueprint.contract = JSON.parse(sanitize(JSON.stringify(contract)));
  }

  const taskBoardPath = path.join(missionPath, 'TASK_BOARD.md');
  if (fs.existsSync(taskBoardPath)) {
    mep.blueprint.procedure = sanitize(safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string);
  }

  if (includeEvidence) {
    const evidenceDir = path.join(missionPath, 'evidence');
    if (fs.existsSync(evidenceDir)) {
      for (const file of fs.readdirSync(evidenceDir)) {
        if (file.endsWith('.json') || file.endsWith('.md') || file.endsWith('.log')) {
          const content = safeReadFile(path.join(evidenceDir, file), { encoding: 'utf8' }) as string;
          mep.evidence.push({
            name: file,
            content: file.endsWith('.json') ? JSON.parse(sanitize(content)) : sanitize(content)
          });
        }
      }
    }
  }

  const outPath = path.resolve(process.cwd(), outputFile || `hub/exports/missions/mep_${missionId}.json`);
  if (!fs.existsSync(path.dirname(outPath))) fs.mkdirSync(path.dirname(outPath), { recursive: true });
  safeWriteFile(outPath, JSON.stringify(mep, null, 2));

  return { status: 'success', output_file: outPath };
}

async function performGeneratePR(input: OrchestratorAction) {
  const { mission_id: missionId } = input;
  if (!missionId) throw new Error('mission_id is required for generate_pr');

  const missionDir = path.resolve(process.cwd(), 'active/missions', missionId);
  const statePath = path.join(missionDir, 'mission-state.json');
  const boardPath = path.join(missionDir, 'TASK_BOARD.md');

  if (!fs.existsSync(statePath)) throw new Error(`Mission state for ${missionId} not found.`);

  const state = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string);
  const board = fs.existsSync(boardPath) ? safeReadFile(boardPath, { encoding: 'utf8' }) as string : '';

  let prBody = `# Mission PR: ${state.mission_id}\n\n`;
  prBody += `## 🎯 Overview\nThis PR completes the mission **${state.mission_id}**.\n`;
  prBody += `**Persona**: ${state.assigned_persona} | **Priority**: ${state.priority}\n\n`;

  if (Array.isArray(state.milestones)) {
    prBody += `## 🏆 Achieved Milestones\n`;
    state.milestones.forEach((m: any) => {
      const icon = m.status === 'completed' ? '✅' : '⏳';
      prBody += `- ${icon} **${m.title}** (${m.status})\n`;
    });
    prBody += `\n`;
  }

  prBody += `## 📋 Task Board Summary\n\`\`\`markdown\n${board.substring(0, 500)}...\n\`\`\`\n\n`;
  prBody += `---\n*Generated autonomously by Kyberion Sovereign Governance.*`;

  const outputPath = path.join(missionDir, 'PR_DESCRIPTION.md');
  safeWriteFile(outputPath, prBody);

  return { status: 'success', pr_path: outputPath };
}

async function performRunTasks(input: OrchestratorAction) {
  const tasksDefPath = path.resolve(process.cwd(), 'scripts/config/routine-tasks.json');
  const statusPath = path.resolve(process.cwd(), 'active/maintenance/daily-log.json');
  
  if (!fs.existsSync(tasksDefPath)) return { status: 'no_tasks_defined' };

  const { tasks } = JSON.parse(safeReadFile(tasksDefPath, { encoding: 'utf8' }) as string);
  const status = fs.existsSync(statusPath) ? JSON.parse(safeReadFile(statusPath, { encoding: 'utf8' }) as string) : {};
  const today = new Date().toISOString().slice(0, 10);
  const currentRole = input.persona || 'mission_controller';

  const pending = tasks.filter((t: any) => {
    return status[t.id] !== today && (t.required_role === currentRole || t.layer === 'Base');
  });

  if (pending.length === 0) return { status: 'nothing_to_do' };

  const results = [];
  for (const task of pending) {
    try {
      if (task.skill) {
        safeExec('node', ['dist/scripts/cli.js', 'run', task.skill, task.args || '']);
      } else if (task.cmd) {
        const parts = task.cmd.split(' ');
        safeExec(parts[0], parts.slice(1));
      }
      status[task.id] = today;
      results.push({ id: task.id, status: 'success' });
    } catch (err: any) {
      results.push({ id: task.id, status: 'failed', error: err.message });
    }
  }

  safeWriteFile(statusPath, JSON.stringify(status, null, 2));
  return { status: 'finished', tasks_run: results.length, details: results };
}

async function performMaterialize(input: OrchestratorAction) {
  const blueprintPath = path.resolve(process.cwd(), input.blueprint_path || 'knowledge/governance/ecosystem-blueprint.json');
  if (!fs.existsSync(blueprintPath)) throw new Error(`Blueprint not found at ${blueprintPath}`);

  const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));
  const infra = blueprint.infrastructure;

  logger.info(`🏗️  Materializing ecosystem: ${blueprint.name}`);

  // 1. Ensure Directories
  if (infra.directories) {
    for (const dir of infra.directories) {
      const fullPath = path.resolve(process.cwd(), dir);
      if (!fs.existsSync(fullPath)) {
        logger.info(`  - Creating directory: ${dir}`);
        fs.mkdirSync(fullPath, { recursive: true });
      }
    }
  }

  // 2. Initial Files
  if (infra.initial_files) {
    for (const file of infra.initial_files) {
      const fullPath = path.resolve(process.cwd(), file.path);
      if (!fs.existsSync(fullPath)) {
        logger.info(`  - Creating file: ${file.path}`);
        safeWriteFile(fullPath, file.content);
      }
    }
  }

  // 3. Symbolic Links
  if (infra.links) {
    for (const link of infra.links) {
      const targetPath = path.resolve(process.cwd(), link.target);
      const sourcePath = path.resolve(process.cwd(), link.source);
      
      if (!fs.existsSync(path.dirname(targetPath))) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      }

      if (fs.existsSync(targetPath)) {
        const stats = fs.lstatSync(targetPath);
        if (stats.isSymbolicLink() || stats.isFile()) {
          fs.unlinkSync(targetPath);
        } else if (stats.isDirectory()) {
          fs.rmSync(targetPath, { recursive: true, force: true });
        }
      }

      const relativeSource = path.relative(path.dirname(targetPath), sourcePath);
      logger.info(`  - Linking: ${link.target} -> ${relativeSource}`);
      fs.symlinkSync(relativeSource, targetPath, link.type || 'dir');
    }
  }

  // 4. Commands
  if (infra.commands) {
    for (const cmd of infra.commands) {
      logger.info(`  - Executing: ${cmd.name} (${cmd.command} ${cmd.args.join(' ')})`);
      try {
        safeExec(cmd.command, cmd.args);
      } catch (err: any) {
        if (cmd.optional) {
          logger.warn(`  - [SKIP] Optional command failed: ${cmd.name}`);
        } else {
          throw err;
        }
      }
    }
  }

  return { status: 'success', name: blueprint.name };
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
