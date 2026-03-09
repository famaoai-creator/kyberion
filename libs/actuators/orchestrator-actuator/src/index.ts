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
  action: 'execute' | 'heal' | 'checkpoint' | 'verify_alignment' | 'materialize' | 'import_mission' | 'export_mission' | 'generate_pr' | 'run_tasks' | 'init_wizard' | 'intent_gateway' | 'create_skill' | 'scaffold_skills' | 'iterm_schedule' | 'run_pipeline' | 'manage_plugin';
  pipeline_path?: string;
  mission_id?: string;
  blueprint_path?: string; // for 'materialize' action
  mep_path?: string; // for 'import_mission'
  output_file?: string; // for 'export_mission'
  include_evidence?: boolean; // for 'export_mission'
  persona?: string; // for 'run_tasks'
  params?: any; // generic params for new ADF actions
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

    case 'init_wizard':
      return await performInitWizard(input);

    case 'intent_gateway':
      return await performIntentGateway(input);

    case 'create_skill':
      return await performCreateSkill(input);

    case 'scaffold_skills':
      return await performScaffoldSkills(input);

    case 'iterm_schedule':
      return await performItermSchedule(input);

    case 'run_pipeline':
      return await performRunPipeline(input);

    case 'manage_plugin':
      return await performManagePlugin(input);

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

async function performInitWizard(input: OrchestratorAction) {
  const { domain, role } = input.params || {};
  if (!domain || !role) throw new Error('domain and role are required for init_wizard');

  const rolesDataPath = path.resolve(process.cwd(), 'knowledge/personalities/roles.json');
  const rawData = safeReadFile(rolesDataPath, { encoding: 'utf8' }) as string;
  const rolesData = JSON.parse(rawData);

  const roleConfig = rolesData.roles[role];
  if (!roleConfig) throw new Error(`Role config not found for: ${role}`);

  logger.info(`Initializing environment for role: ${role}...`);

  const essentialDirs = [
    'knowledge/personal/.gitkeep', 'knowledge/confidential/.gitkeep', 'vault/.gitkeep',
    'active/projects/.gitkeep', 'active/missions/.gitkeep', 'active/shared/governance/.gitkeep',
    'active/shared/runtime/vision/frames/.gitkeep', 'scratch/.gitkeep',
    'presence/bridge/.gitkeep', 'presence/sensors/.gitkeep'
  ];

  essentialDirs.forEach(file => safeWriteFile(path.join(process.cwd(), file), ''));

  const identity = { owner_name: 'Sovereign User', preferred_language: 'ja', interaction_style: 'YOLO/Concise', last_initialized: new Date().toISOString() };
  safeWriteFile(path.resolve(process.cwd(), 'knowledge/personal/my-identity.json'), JSON.stringify(identity, null, 2));

  const sessionConfig = { active_role: role, persona: `The ${role}`, mission: roleConfig.description, tier_access: 'personal', recommended_skills: roleConfig.skills, timestamp: new Date().toISOString() };
  safeWriteFile(path.resolve(process.cwd(), 'active/shared/governance/session.json'), JSON.stringify(sessionConfig, null, 2));

  return { status: 'success', role, persona: sessionConfig.persona };
}

async function performIntentGateway(input: OrchestratorAction) {
  const { query } = input.params || {};
  if (!query) throw new Error('query is required for intent_gateway');

  const mappingPath = path.resolve(process.cwd(), 'knowledge/orchestration/meta-skills/intent_mapping.yaml');
  const indexPath = path.resolve(process.cwd(), 'knowledge/orchestration/global_skill_index.json');

  const mapping = yaml.load(safeReadFile(mappingPath, { encoding: 'utf8' }) as string) as any;
  const index = JSON.parse(safeReadFile(indexPath, { encoding: 'utf8' }) as string);
  const skills = index.s || [];

  const detected = mapping.intents.find((intent: any) => 
    intent.trigger_phrases.some((phrase: string) => query.toLowerCase().includes(phrase.toLowerCase()))
  );

  if (!detected) return { status: 'no_match', query };

  const chain = detected.chain.map((skillName: string) => {
    const info = skills.find((s: any) => s.n === skillName);
    return info ? { name: skillName, path: info.path } : { name: skillName, status: 'missing' };
  });

  return { status: 'success', intent: detected.name, chain };
}

async function performCreateSkill(input: OrchestratorAction) {
  const { category, skill_name: name } = input.params || {};
  if (!category || !name) throw new Error('category and skill_name are required for create_skill');

  const skillDir = path.join(process.cwd(), 'skills', category, name);
  if (fs.existsSync(skillDir)) throw new Error(`Skill directory already exists: ${skillDir}`);

  fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });

  const pkg = { name: `@agent/skill-${name}`, version: '1.0.0', private: true, main: 'dist/index.js', types: 'dist/index.d.ts', scripts: { "build": "tsc", "test": "vitest run" }, dependencies: { "@agent/core": "workspace:*" } };
  safeWriteFile(path.join(skillDir, 'package.json'), JSON.stringify(pkg, null, 2));

  const tsconfig = { extends: "../../../tsconfig.json", compilerOptions: { outDir: "./dist", rootDir: "./src" }, include: ["src/**/*"] };
  safeWriteFile(path.join(skillDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

  const md = `---\nname: ${name}\ndescription: A new Gemini skill for ${name}.\nstatus: planned\ncategory: ${category.charAt(0).toUpperCase() + category.slice(1)}\nlast_updated: '${new Date().toISOString().split('T')[0]}'\n---\n\n# ${name}\n\n## 📋 Role & Responsibility\n(Describe what this skill does)\n\n## 🛠️ Usage\n\`\`\`bash\nnpm run cli -- ${name}\n\`\`\`\n`;
  safeWriteFile(path.join(skillDir, 'SKILL.md'), md);

  const lib = `import { logger } from '@agent/core';\n\nexport function executeLogic() {\n  logger.info('Executing ${name} logic...');\n  return { success: true };\n}\n`;
  safeWriteFile(path.join(skillDir, 'src/lib.ts'), lib);

  const index = `import { runSkill } from '@agent/core';\nimport { executeLogic } from './lib.js';\n\nasync function main(args: any) {\n  return executeLogic();\n}\n\nrunSkill(main);\n`;
  safeWriteFile(path.join(skillDir, 'src/index.ts'), index);

  return { status: 'success', path: skillDir };
}

async function performScaffoldSkills(input: OrchestratorAction) {
  const { category = 'custom', skills = [] } = input.params || {};
  if (skills.length === 0) return { status: 'no_skills_to_scaffold' };

  const results = [];
  for (const skill of skills) {
    try {
      const result = await performCreateSkill({ action: 'create_skill', params: { category, skill_name: skill.name } });
      results.push({ name: skill.name, status: 'success', path: result.path });
    } catch (err: any) {
      results.push({ name: skill.name, status: 'failed', error: err.message });
    }
  }
  return { status: 'finished', results };
}

async function performItermSchedule(input: OrchestratorAction) {
  const { prompt } = input.params || {};
  if (!prompt) throw new Error('prompt is required for iterm_schedule');

  if (process.platform !== 'darwin') return { status: 'skipped', reason: 'Non-macos platform' };

  const findSessionScript = `tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if contents of s contains "> Type your message" then
            if is processing of s is false then
              return (id of w as string) & ":" & (id of s as string)
            end if
          end if
        end repeat
      end repeat
    end repeat
    return "NOT_FOUND"
  end tell`;

  const result = safeExec('osascript', ['-e', findSessionScript], { encoding: 'utf8' }).trim();
  if (result === 'NOT_FOUND') return { status: 'session_not_found' };

  const [winId, sessionId] = result.split(':');
  const sendScript = `tell application "iTerm2"
    tell (first window whose id is ${winId})
      tell (first session whose id is "${sessionId}")
        write text "${prompt.replace(/"/g, '\\"')}"
      end tell
    end tell
  end tell
  tell application "System Events" to key code 36`;

  safeExec('osascript', ['-e', sendScript]);
  return { status: 'success', windowId: winId, sessionId };
}

async function performRunPipeline(input: OrchestratorAction) {
  const { pipeline: pipelineName, vars = {} } = input.params || {};
  if (!pipelineName) throw new Error('pipeline name is required for run_pipeline');

  const pipelineFile = path.join(process.cwd(), 'pipelines', `${pipelineName}.yml`);
  if (!fs.existsSync(pipelineFile)) throw new Error(`Pipeline "${pipelineName}" not found`);

  const pipelineDef: any = yaml.load(fs.readFileSync(pipelineFile, 'utf8'));
  const results = [];

  const interpolate = (template: string, v: any) => {
    if (typeof template !== 'string') return template;
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(v[key] || ''));
  };

  for (const step of pipelineDef.steps) {
    const skillName = step.skill;
    const args = step.args ? interpolate(step.args, vars) : '';
    const cwd = step.cwd ? path.resolve(interpolate(step.cwd, vars)) : process.cwd();

    try {
      const stdout = safeExec('node', ['dist/scripts/cli.js', 'run', skillName, ...args.split(' ').filter(Boolean)], { cwd });
      results.push({ skill: skillName, status: 'success', data: stdout });
    } catch (err: any) {
      results.push({ skill: skillName, status: 'error', error: err.message });
      if (!step.continue_on_error) break;
    }
  }

  return { status: 'finished', pipeline: pipelineName, steps: results };
}

async function performManagePlugin(input: OrchestratorAction) {
  const { plugin_action, target, category = 'utilities' } = input.params || {};
  const registryPath = path.join(process.cwd(), 'knowledge/orchestration/plugin-registry.json');
  
  const loadRegistry = () => fs.existsSync(registryPath) ? JSON.parse(safeReadFile(registryPath, { encoding: 'utf8' }) as string) : { plugins: [], last_updated: null };
  const saveRegistry = (r: any) => { r.last_updated = new Date().toISOString(); safeWriteFile(registryPath, JSON.stringify(r, null, 2)); };

  const registry = loadRegistry();

  switch (plugin_action) {
    case 'register':
      if (!target) throw new Error('target path required for register');
      const absDir = path.resolve(target);
      const skillMd = path.join(absDir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) throw new Error('No SKILL.md found');
      
      const content = fs.readFileSync(skillMd, 'utf8');
      const name = (content.match(/^name:\s*(.+)$/m)?.[1] || path.basename(absDir)).trim();
      
      const linkPath = path.join(process.cwd(), 'skills', category, name);
      if (!fs.existsSync(path.dirname(linkPath))) fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      if (!fs.existsSync(linkPath)) fs.symlinkSync(absDir, linkPath, 'dir');

      registry.plugins.push({ name, category, path: absDir, installed_at: new Date().toISOString(), type: 'local' });
      saveRegistry(registry);
      return { status: 'registered', name, path: linkPath };

    case 'uninstall':
      const idx = registry.plugins.findIndex((p: any) => p.name === target);
      if (idx === -1) throw new Error(`Plugin "${target}" not found`);
      const p = registry.plugins[idx];
      const lp = path.join(process.cwd(), 'skills', p.category || 'utilities', p.name);
      if (fs.existsSync(lp) && fs.lstatSync(lp).isSymbolicLink()) fs.unlinkSync(lp);
      registry.plugins.splice(idx, 1);
      saveRegistry(registry);
      return { status: 'uninstalled', name: target };

    case 'list':
      return { status: 'success', plugins: registry.plugins };
    
    default:
      throw new Error(`Unsupported plugin action: ${plugin_action}`);
  }
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
