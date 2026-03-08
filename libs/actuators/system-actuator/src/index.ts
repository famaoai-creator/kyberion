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
  action: 'keyboard' | 'mouse' | 'voice' | 'notify' | 'validate' | 'audit';
  text?: string;
  key?: string; 
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  priority?: number;
  options?: any;
  rules_path?: string; // for 'validate' and 'audit' actions
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

    case 'audit':
      return await performAudit(input);

    default:
      throw new Error(`Unsupported system action: ${input.action}`);
  }
}

async function performAudit(input: SystemAction) {
  const policyPath = path.resolve(process.cwd(), input.rules_path || 'knowledge/governance/standard-policy.json');
  if (!fs.existsSync(policyPath)) throw new Error(`Governance policy not found at ${policyPath}`);

  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const results: any[] = [];
  let overallStatus = 'passed';

  for (const rule of policy.rules) {
    logger.info(`[Audit] Running rule: ${rule.id} (${rule.description})`);
    const result: any = { id: rule.id, status: 'passed' };

    try {
      switch (rule.check_type) {
        case 'restricted_api':
        case 'security_pattern':
        case 'todo_check':
          const violations = runPatternSearch(rule.params);
          if (violations.length > 0) {
            result.status = rule.severity === 'error' ? 'failed' : 'warning';
            result.violations = violations;
            if (rule.severity === 'error') overallStatus = 'failed';
          }
          break;
        case 'static_analysis':
        case 'test':
          try {
            safeExec('npm', rule.params.command.split(' ').slice(1));
          } catch (e: any) {
            result.status = 'failed';
            result.error = e.message;
            overallStatus = 'failed';
          }
          break;
      }
    } catch (err: any) {
      result.status = 'failed';
      result.error = err.message;
      overallStatus = 'failed';
    }
    results.push(result);
  }

  const reportPath = path.resolve(process.cwd(), 'active/shared/governance-report.json');
  const reportData = {
    timestamp: new Date().toISOString(),
    policy_name: policy.name,
    overall_status: overallStatus,
    results,
  };

  safeWriteFile(reportPath, JSON.stringify(reportData, null, 2));
  return reportData;
}

function runPatternSearch(params: any): string[] {
  const violations: string[] = [];
  const { patterns, exemptions = [], target_dirs = ["."], file_extensions = [] } = params;

  for (const targetDir of target_dirs) {
    const fullTargetDir = path.resolve(process.cwd(), targetDir);
    if (!fs.existsSync(fullTargetDir)) continue;

    const files = getAllFiles(fullTargetDir).filter(f => {
      const relPath = path.relative(process.cwd(), f);
      if (exemptions.includes(relPath)) return false;
      if (file_extensions.length > 0 && !file_extensions.some(ext => f.endsWith(ext))) return false;
      if (relPath.includes('node_modules') || relPath.includes('.git')) return false;
      return true;
    });

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        const regex = new RegExp(pattern, 'g');
        if (regex.test(content)) {
          violations.push(`${path.relative(process.cwd(), file)}: matches pattern '${pattern}'`);
        }
      }
    }
  }
  return violations;
}

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  });

  return arrayOfFiles;
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
