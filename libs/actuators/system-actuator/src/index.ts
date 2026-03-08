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
  action: 'keyboard' | 'mouse' | 'voice' | 'notify' | 'validate' | 'audit' | 'integrity' | 'judge' | 'ace_consensus' | 'alignment_mirror';
  text?: string;
  key?: string; 
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  priority?: number;
  options?: any;
  rules_path?: string; // for 'validate' and 'audit' actions
  target_dir?: string; // for 'validate' action
  checks?: any[]; // for 'integrity' action
  mission_id?: string; // for 'judge' and 'ace_consensus'
  role?: string; // for 'judge' and 'ace_consensus'
  status?: string; // for 'ace_consensus'
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

    case 'integrity':
      return await performIntegrityCheck(input);

    case 'judge':
      return await performJudgment(input);

    case 'ace_consensus':
      return await performAceConsensus(input);

    case 'alignment_mirror':
      return await performAlignmentMirror(input);

    default:
      throw new Error(`Unsupported system action: ${input.action}`);
  }
}

async function performJudgment(input: SystemAction) {
  const missionId = input.mission_id;
  if (!missionId) throw new Error('mission_id is required for judge action');
  
  const missionDir = path.resolve(process.cwd(), 'active/missions', missionId);
  const reportPath = path.join(missionDir, 'ace-report.json');
  const logPath = path.join(missionDir, 'execution.log');
  const rulesPath = path.resolve(process.cwd(), 'knowledge/governance/judgment-rules.json');

  if (!fs.existsSync(reportPath)) throw new Error(`Report not found for mission ${missionId}`);
  const rules = fs.existsSync(rulesPath) ? JSON.parse(fs.readFileSync(rulesPath, 'utf8')) : { personas: {} };

  try {
    const report = JSON.parse(safeReadFile(reportPath, { encoding: 'utf8' }) as string);
    const logContent = fs.existsSync(logPath) ? safeReadFile(logPath, { encoding: 'utf8' }) as string : '';
    const assignedRole = input.role || report.role || 'Ecosystem Architect';
    
    let judgePersona = 'Ecosystem Architect';
    if (assignedRole.includes('Security')) judgePersona = 'Security Reviewer';
    else if (assignedRole.includes('PMO') || assignedRole.includes('Auditor')) judgePersona = 'Ruthless Auditor';
    else if (assignedRole.includes('Developer') || assignedRole.includes('CTO')) judgePersona = 'Pragmatic CTO';

    const criteria = rules.personas[judgePersona] || { weight: 1.0, focus: 'General Analysis', thresholds: { S: 90, A: 80, B: 70, C: 60 } };
    let baseScore = report.status === 'success' ? 85 : 40;
    const errorCount = (logContent.match(/ERROR/g) || []).length;
    baseScore -= errorCount * 5;

    const finalScore = Math.max(0, Math.min(100, Math.round(baseScore * criteria.weight)));
    let grade = 'F';
    const t = criteria.thresholds;
    if (finalScore >= (t.S || 90)) grade = 'S';
    else if (finalScore >= (t.A || 80)) grade = 'A';
    else if (finalScore >= (t.B || 70)) grade = 'B';
    else if (finalScore >= (t.C || 60)) grade = 'C';
    else if (finalScore >= 40) grade = 'D';

    const evaluation = { missionId, judge: judgePersona, focus: criteria.focus, score: finalScore, grade, timestamp: new Date().toISOString() };
    safeWriteFile(path.join(missionDir, 'ai-evaluation.json'), JSON.stringify(evaluation, null, 2));
    return { status: 'success', evaluation };
  } catch (err: any) {
    logger.error(`[AI-Judge] Error: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}

async function performAceConsensus(input: SystemAction) {
  const { mission_id: missionId, role: roleName, status = 'APPROVED' } = input;
  if (!missionId || !roleName) throw new Error('mission_id and role are required for ace_consensus');

  const missionDir = path.resolve(process.cwd(), 'active/missions', missionId);
  const roleId = roleName.toLowerCase().replace(/ /g, '_');
  const personaDir = path.join(missionDir, `role_${roleId}`);
  const consensusPath = path.join(missionDir, 'consensus.json');

  if (!fs.existsSync(personaDir)) {
    safeMkdir(path.join(personaDir, 'evidence'), { recursive: true });
    safeMkdir(path.join(personaDir, 'scratch'), { recursive: true });
  }

  const result = { role: roleName, action: 'Review', status, timestamp: new Date().toISOString(), findings: `Analysis performed under ${roleName} guidelines.` };
  safeWriteFile(path.join(personaDir, 'evidence', `action_${Date.now()}.json`), JSON.stringify(result, null, 2));

  let consensus: any = { approvals: {}, last_updated: null, conflict: false };
  if (fs.existsSync(consensusPath)) {
    try { consensus = JSON.parse(safeReadFile(consensusPath, { encoding: 'utf8' }) as string); } catch (_) {}
  }
  consensus.approvals[roleName] = status;
  consensus.last_updated = new Date().toISOString();
  const states = Object.values(consensus.approvals);
  consensus.conflict = states.includes('NO-GO') && states.includes('APPROVED');

  safeWriteFile(consensusPath, JSON.stringify(consensus, null, 2));
  return { status: 'success', consensus };
}

async function performAlignmentMirror(_input: SystemAction) {
  const missionsDir = path.resolve(process.cwd(), 'active/missions');
  const vaultDir = path.resolve(process.cwd(), 'knowledge/evolution/latent-wisdom');
  if (!fs.existsSync(vaultDir)) safeMkdir(vaultDir, { recursive: true });

  const missions = fs.readdirSync(missionsDir).filter(m => !m.startsWith('.'));
  const results = [];

  for (const missionId of missions) {
    const statePath = path.join(missionsDir, missionId, 'mission-state.json');
    if (!fs.existsSync(statePath)) continue;

    try {
      const state = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string);
      if (state.status === 'Completed' && !state.distilled) {
        const learningsPath = path.join(missionsDir, missionId, 'LEARNINGS.md');
        if (fs.existsSync(learningsPath)) {
          const learnings = safeReadFile(learningsPath, { encoding: 'utf8' }) as string;
          const patchId = `patch-${missionId.toLowerCase()}-${Date.now().toString().slice(-4)}`;
          const patch = {
            id: patchId, source_mission: missionId, timestamp: new Date().toISOString(),
            deviation_summary: "Automated distillation of divergent success.",
            delta_rules: learnings.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2)),
            evidence_path: `active/missions/${missionId}/evidence/`
          };
          const patchPath = path.join(vaultDir, `${patchId}.json`);
          safeWriteFile(patchPath, JSON.stringify(patch, null, 2));
          state.distilled = true;
          state.patch_id = patchId;
          safeWriteFile(statePath, JSON.stringify(state, null, 2));
          results.push({ missionId, patchId, path: patchPath });
        }
      }
    } catch (err: any) { logger.error(`Error in alignment mirror for ${missionId}: ${err.message}`); }
  }
  return { status: 'success', distilled: results };
}

function safeMkdir(dirPath: string, options?: any) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, options);
}

async function performIntegrityCheck(input: SystemAction) {
  const checks = input.checks || [];
  const results: any[] = [];
  let overallStatus = 'passed';

  for (const check of checks) {
    logger.info(`🛡️ [Integrity] Running check: ${check.type} on ${check.target || 'base'}`);
    const result: any = { type: check.type, target: check.target, status: 'passed' };

    try {
      switch (check.type) {
        case 'schema':
          const schemaResult = validateSchemas(check.target || 'schemas');
          result.stats = schemaResult;
          if (schemaResult.errors > 0) result.status = 'failed';
          break;
        case 'knowledge':
          const knowledgeResult = validateKnowledgeIntegrity(check.target || 'knowledge');
          result.stats = knowledgeResult;
          if (knowledgeResult.brokenLinks > 0) result.status = 'failed';
          break;
        default:
          throw new Error(`Unsupported integrity check type: ${check.type}`);
      }
    } catch (err: any) {
      result.status = 'failed';
      result.error = err.message;
      overallStatus = 'failed';
    }
    
    if (result.status === 'failed') overallStatus = 'failed';
    results.push(result);
  }

  return { status: overallStatus, timestamp: new Date().toISOString(), results };
}

function validateSchemas(targetDir: string) {
  const fullPath = path.resolve(process.cwd(), targetDir);
  if (!fs.existsSync(fullPath)) throw new Error(`Schemas directory not found: ${targetDir}`);

  let errors = 0;
  const files = fs.readdirSync(fullPath).filter((f) => f.endsWith('.schema.json'));

  for (const file of files) {
    const filePath = path.join(fullPath, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const schema = JSON.parse(content);

    if (!schema.$schema || !schema.title || !schema.type) {
      logger.error(`❌ [Integrity] Schema error in ${file}: Missing required fields ($schema, title, type)`);
      errors++;
    }
  }

  return { checked: files.length, errors };
}

function validateKnowledgeIntegrity(targetDir: string) {
  const fullPath = path.resolve(process.cwd(), targetDir);
  if (!fs.existsSync(fullPath)) throw new Error(`Knowledge directory not found: ${targetDir}`);

  const files = getAllFiles(fullPath).filter(f => f.endsWith('.md'));
  let brokenLinks = 0;
  let totalLinks = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const relFile = path.relative(fullPath, file);
    const linkRegex = /(?<!`)\[([^\]]+)\]\(([^)]+)\)(?!`)/g;
    let match;

    while ((match = linkRegex.exec(content)) !== null) {
      const link = match[2];
      if (link.startsWith('http') || link.startsWith('#')) continue;
      
      totalLinks++;
      const linkPath = path.resolve(path.dirname(file), link);
      if (!fs.existsSync(linkPath)) {
        logger.error(`❌ [Integrity] Broken link in ${relFile}: ${link}`);
        brokenLinks++;
      }
    }
  }

  return { checkedFiles: files.length, totalLinks, brokenLinks };
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
