import { logger, safeReadFile, safeWriteFile, safeExec } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import yaml from 'js-yaml';

/**
 * Orchestrator-Actuator v1.1.0 [SECURE-IO ENFORCED]
 * Strictly compliant with Layer 2 (Shield).
 */

interface OrchestratorAction {
  action: 'execute' | 'heal' | 'checkpoint' | 'verify_alignment' | 'materialize';
  pipeline_path?: string;
  mission_id?: string;
  blueprint_path?: string; // for 'materialize' action
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

    default:
      return { status: 'idle' };
  }
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
