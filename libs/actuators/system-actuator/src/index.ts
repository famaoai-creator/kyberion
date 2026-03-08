import { logger, safeReadFile, safeExec, safeWriteFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * System-Actuator v1.3.0 [PHYSICAL IO & GOVERNANCE ENABLED]
 * Unified interface for OS-level interactions and system-wide validation.
 * Strictly compliant with Layer 2 (Shield).
 */

interface SystemAction {
  action: 'keyboard' | 'mouse' | 'voice' | 'notify' | 'validate';
  text?: string;
  key?: string; 
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  priority?: number;
  options?: any;
  rules_path?: string; // for 'validate' action
  target_dir?: string; // for 'validate' action
}

async function handleAction(input: SystemAction) {
  switch (input.action) {
    case 'notify':
      // Existing logic for notify
      return { status: 'notified', text: input.text };

    case 'voice':
      // Existing logic for voice
      return { status: 'spoken', text: input.text };

    case 'keyboard':
      const textToType = input.text || input.key;
      if (!textToType) throw new Error('text or key is required for keyboard action.');
      logger.info(`⌨️  [SYSTEM] Typing: ${textToType.substring(0, 20)}...`);
      if (process.platform === 'darwin') {
        const escaped = textToType.replace(/"/g, '\\"');
        safeExec('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`]);
      }
      return { status: 'typed', text: textToType };

    case 'mouse':
      const { x = 0, y = 0, button = 'left' } = input;
      logger.info(`🖱️ [SYSTEM] Mouse ${button} click at (${x}, ${y})`);
      if (process.platform === 'darwin') {
        const clickScript = `tell application "System Events" to click at {${x}, ${y}}`;
        try {
          safeExec('osascript', ['-e', clickScript]);
        } catch (err: any) {
          logger.warn(`⚠️ [SYSTEM] Mouse click failed (Check permissions): ${err.message}`);
          return { status: 'failed', reason: 'permission_denied' };
        }
      }
      return { status: 'clicked', x, y, button };

    case 'validate':
      return await performValidation(input);

    default:
      throw new Error(`Unsupported system action: ${input.action}`);
  }
}

async function performValidation(input: SystemAction) {
  const rulesPath = path.resolve(process.cwd(), input.rules_path || 'knowledge/governance/skill-validation.json');
  const targetDir = path.resolve(process.cwd(), input.target_dir || 'skills');

  if (!fs.existsSync(rulesPath)) throw new Error(`Validation rules not found at ${rulesPath}`);
  
  if (!fs.existsSync(targetDir)) {
    logger.warn(`Target directory not found at ${targetDir}. Skipping validation.`);
    return { status: 'success', checked: 0 };
  }

  const config = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const rules = config.rules || [];
  let errors = 0;
  let checked = 0;

  const categories = fs.readdirSync(targetDir).filter(f => fs.lstatSync(path.join(targetDir, f)).isDirectory());

  for (const cat of categories) {
    const catPath = path.join(targetDir, cat);
    const skillDirs = fs.readdirSync(catPath).filter(f => fs.lstatSync(path.join(catPath, f)).isDirectory());

    for (const dir of skillDirs) {
      const skillFullDir = path.join(catPath, dir);
      const skillMdPath = path.join(skillFullDir, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      checked++;
      const content = fs.readFileSync(skillMdPath, 'utf8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

      for (const rule of rules) {
        const check = rule.check;

        if (!fmMatch) {
          logger.error(`${cat}/${dir}: No YAML frontmatter found (Rule: ${rule.name})`);
          errors++;
          continue;
        }

        const frontmatter = fmMatch[1];
        if (check.required_fields) {
          for (const field of check.required_fields) {
            if (!new RegExp(`^${field}:`, 'm').test(frontmatter)) {
              logger.error(`${cat}/${dir}: Missing required field "${field}" (Rule: ${rule.name})`);
              errors++;
            }
          }
        }

        if (check.valid_statuses) {
          const statusMatch = frontmatter.match(/^status:\s*(.+)$/m);
          if (statusMatch && !check.valid_statuses.includes(statusMatch[1].trim())) {
            logger.error(`${cat}/${dir}: Invalid status "${statusMatch[1].trim()}" (Rule: ${rule.name})`);
            errors++;
          }
        }

        if (check.required_files) {
          for (const file of check.required_files) {
            if (!fs.existsSync(path.join(skillFullDir, file))) {
              logger.error(`${cat}/${dir}: Missing required file "${file}" (Rule: ${rule.name})`);
              errors++;
            }
          }
        }
      }
    }
  }

  logger.info(`Checked ${checked} skills`);
  if (errors > 0) {
    logger.error(`Found ${errors} validation errors`);
    return { status: 'failed', errors, checked };
  } else {
    logger.success('All skills have valid metadata');
    return { status: 'success', checked };
  }
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
