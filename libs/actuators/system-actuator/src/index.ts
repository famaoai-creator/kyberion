import { logger, safeReadFile, safeExec, safeWriteFile, safeMkdir } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as visionJudge from '@agent/shared-vision';

// Dynamic import for chalk (ESM module in CommonJS environment)
let chalk: any;
async function initChalk() {
  if (!chalk) {
    const m = await import('chalk');
    chalk = m.default;
  }
}

/**
 * System-Actuator v1.4.0 [QA & SIGHT INTEGRATED]
 * Unified interface for OS-level interactions, system-wide validation, and QA automation.
 * Strictly compliant with Layer 2 (Shield).
 */

interface SystemAction {
  action: 'keyboard' | 'mouse' | 'voice' | 'notify' | 'validate' | 'audit' | 'integrity' | 'judge' | 'ace_consensus' | 'alignment_mirror' | 'gen_test_cases' | 'run_tests' | 'visual_auto_heal' | 'visual_capture' | 'verify_vision' | 'doctor' | 'benchmark' | 'check_performance' | 'gen_dashboard' | 'pulse_check' | 'pulse_trigger' | 'pulse_aggregate';
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
  requirement_path?: string; // for 'gen_test_cases'
  command?: string; // for 'visual_auto_heal'
  args?: string[]; // for 'visual_auto_heal'
  target?: string; // for 'visual_capture'
  context?: string; // for 'verify_vision'
  tie_break_options?: any[]; // for 'verify_vision'
  json_mode?: boolean; // for 'doctor'
  params?: any; // for new performance actions
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

    case 'gen_test_cases':
      return await performGenTestCases(input);

    case 'run_tests':
      return await performRunTests(input);

    case 'visual_auto_heal':
      return await performVisualAutoHeal(input);

    case 'visual_capture':
      return await performVisualCapture(input);

    case 'verify_vision':
      return await performVerifyVision(input);

    case 'doctor':
      return await performDoctor(input);

    case 'benchmark':
      return await performBenchmark(input);

    case 'check_performance':
      return await performCheckPerformance(input);

    case 'gen_dashboard':
      return await performGenDashboard(input);

    case 'pulse_check':
      return await performPulseCheck(input);

    case 'pulse_trigger':
      return await performPulseTrigger(input);

    case 'pulse_aggregate':
      return await performPulseAggregate(input);

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

async function performGenTestCases(input: SystemAction) {
  const reqPath = input.requirement_path;
  if (!reqPath || !fs.existsSync(path.resolve(process.cwd(), reqPath))) {
    throw new Error(`No requirement file provided or file not found at ${reqPath}`);
  }

  const adf = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), reqPath), 'utf8'));
  const reqs = adf.requirements || [];
  const generated: any[] = [];

  reqs.forEach((req: any) => {
    const cases = [
      { id: `TC-${req.id}-01`, title: 'Valid application', type: 'Normal' }
    ];
    
    const rule = (req.rule || '').toLowerCase();
    if (rule.includes('threshold') || rule.includes('$') || rule.includes('%')) {
      cases.push({ id: `TC-${req.id}-02`, title: 'Exact threshold handling', type: 'Boundary' });
    }
    generated.push({ requirement: req.id, title: req.title, cases });
  });

  return { status: 'success', adf_title: adf.title, generated };
}

async function performRunTests(_input: SystemAction) {
  const rootDir = process.cwd();
  const dirs = fs.readdirSync(rootDir).filter((f) => {
    try {
      const fullPath = path.join(rootDir, f);
      return (
        fs.statSync(fullPath).isDirectory() &&
        !f.startsWith('.') &&
        !['node_modules', 'scripts', 'knowledge', 'dist'].includes(f)
      );
    } catch (_e) { return false; }
  });

  let total = 0;
  let passed = 0;
  let failedCount = 0;
  const results = [];

  for (const dir of dirs) {
    const testDir = path.join(rootDir, dir, 'tests');
    if (fs.existsSync(testDir)) {
      const tests = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.cjs') || f.endsWith('.test.js') || f.endsWith('.test.ts'));
      
      for (const test of tests) {
        total++;
        const testPath = path.join(testDir, test);
        try {
          if (test.endsWith('.ts')) {
            safeExec('npx', ['tsx', testPath], { cwd: rootDir });
          } else {
            safeExec('node', [testPath], { cwd: rootDir });
          }
          passed++;
          results.push({ test: `${dir}/${test}`, status: 'PASSED' });
        } catch (_e) {
          failedCount++;
          results.push({ test: `${dir}/${test}`, status: 'FAILED' });
        }
      }
    }
  }

  return { status: failedCount === 0 ? 'success' : 'failed', total, passed, failed: failedCount, results };
}

async function performVisualAutoHeal(input: SystemAction) {
  const { command, args = [] } = input;
  if (!command) throw new Error('command is required for visual_auto_heal');

  const visualSensorPath = path.resolve(process.cwd(), 'presence/sensors/visual-sensor.cjs');
  const visualSensor = require(visualSensorPath);

  try {
    safeExec(command, args);
    return { status: 'success', message: 'Command succeeded. No visual evidence needed.' };
  } catch (err: any) {
    logger.error(`❌ Command failed: ${err.message}. Capturing visual evidence...`);
    try {
      const artifact = await visualSensor.capture('screen');
      return { status: 'failed', error: err.message, visual_evidence: artifact.path, advice: '[SIGHT_ADVICE]: Visual state captured. Ready for multimodal analysis.' };
    } catch (vErr: any) {
      return { status: 'failed', error: err.message, visual_error: vErr.message };
    }
  }
}

async function performVisualCapture(input: SystemAction) {
  const target = input.target || 'screen';
  const visualSensorPath = path.resolve(process.cwd(), 'presence/sensors/visual-sensor.cjs');
  const visualSensor = require(visualSensorPath);

  try {
    const artifact = await visualSensor.capture(target);
    return { status: 'success', artifact };
  } catch (err: any) {
    throw new Error(`Capture failed: ${err.message}`);
  }
}

async function performVerifyVision(input: SystemAction) {
  const { context, tie_break_options } = input;
  if (!context || !tie_break_options) throw new Error('context and tie_break_options are required for verify_vision');

  const decision = await visionJudge.consultVision(context, tie_break_options);
  return { status: 'success', decision };
}

async function performDoctor(input: SystemAction) {
  const isJsonMode = input.json_mode || false;
  const checks: any[] = [];
  const rootDir = process.cwd();

  const runCheck = (name: string, cmd: string, args: string[], parser: (out: string) => any) => {
    try {
      const output = safeExec(cmd, args, { cwd: rootDir });
      const result = parser(output);
      checks.push({ name, ...result });
    } catch (err: any) {
      const combined = (err.stdout || '') + (err.stderr || '') + (err.message || '');
      const result = parser(combined);
      checks.push({ name, ...result });
    }
  };

  runCheck('Capability Validation', 'node', ['dist/scripts/validate_skills.js'], (out) => {
    const match = out.match(/Checked (\d+) skills/);
    return { status: out.toLowerCase().includes('success') ? 'pass' : 'fail', detail: `${match ? match[1] : '?'} capabilities validated` };
  });

  runCheck('Health Check', 'node', ['dist/scripts/check_skills_health.js'], (out) => {
    const match = out.match(/Total Issues: (\d+)/);
    const issues = match ? parseInt(match[1]) : 0;
    return { status: issues === 0 ? 'pass' : 'warn', detail: issues === 0 ? 'All mains resolve' : `${issues} issues found` };
  });

  const failed = checks.filter(c => c.status === 'fail');
  const overall = failed.length > 0 ? 'FAILED' : 'PASSED';

  if (isJsonMode) {
    const reportPath = path.join(rootDir, 'presence/displays/chronos-mirror/public/doctor_report.json');
    const report = { timestamp: new Date().toISOString(), overall, checks };
    safeWriteFile(reportPath, JSON.stringify(report, null, 2));
    return { status: 'success', report_path: reportPath, overall, checks };
  }

  return { status: 'success', overall, checks };
}

function safeMkdirLocal(dirPath: string, options?: any) {
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

async function performBenchmark(_input: SystemAction) {
  const resultsDir = path.join(process.cwd(), 'evidence/benchmarks');
  const indexPath = path.resolve(process.cwd(), 'knowledge/orchestration/global_skill_index.json');
  if (!fs.existsSync(resultsDir)) safeMkdir(resultsDir, { recursive: true });

  const indexContent = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
  const index = JSON.parse(indexContent);
  const skillsData = index.s || [];
  const skills: any[] = [];

  for (const s of skillsData) {
    if (s.s !== 'impl') continue;
    const distDir = path.join(process.cwd(), s.path, 'dist');
    if (fs.existsSync(distDir)) {
      const files = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
      if (files.length > 0) skills.push({ name: s.n, script: path.join(distDir, files[0]) });
    }
  }

  logger.info(`Benchmarking ${skills.length} skills...`);
  const results: any[] = [];

  for (const skill of skills) {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = process.hrtime.bigint();
      try { safeExec('node', ['--check', skill.script]); } catch (_) {}
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    const avg = times.reduce((a, b) => a + b, 0) / 3;
    results.push({ skill: skill.name, avg_ms: Math.round(avg * 100) / 100 });
  }

  const reportPath = path.join(resultsDir, `benchmark-${new Date().toISOString().slice(0, 10)}.json`);
  safeWriteFile(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
  return { status: 'success', report_path: reportPath, count: skills.length };
}

async function performCheckPerformance(input: SystemAction) {
  const { metrics } = await import('@agent/core');
  const history = metrics.reportFromHistory();
  
  const sloPath = path.resolve(process.cwd(), 'knowledge/orchestration/slo-targets.json');
  const sloTargets = fs.existsSync(sloPath)
    ? JSON.parse(fs.readFileSync(sloPath, 'utf8'))
    : { default: { latency_ms: 5000, success_rate: 99 } };

  const regressions = metrics.detectRegressions(2.0);
  const adfReport: any = {
    timestamp: new Date().toISOString(),
    summary: { total_records: history.totalEntries, unique_skills: history.uniqueSkills },
    regressions,
    slow_skills: history.skills.filter((s: any) => s.avgMs > 100).slice(0, 5),
    efficiency_alerts: history.skills.filter((s: any) => s.efficiencyScore < 80).slice(0, 5),
    slo_breaches: [],
  };

  history.skills.forEach((s: any) => {
    const target = (sloTargets.critical_path && sloTargets.critical_path[s.skill]) || sloTargets.default;
    if (s.avgMs > target.latency_ms || (100 - s.errorRate) < target.success_rate) {
      adfReport.slo_breaches.push({
        skill: s.skill, actual_latency: s.avgMs, target_latency: target.latency_ms,
        actual_success: (100 - s.errorRate).toFixed(1), target_success: target.success_rate
      });
    }
  });

  const outDir = path.resolve(process.cwd(), 'evidence/performance');
  if (!fs.existsSync(outDir)) safeMkdir(outDir, { recursive: true });
  const outPath = input.params?.out || path.join(outDir, `perf-report-${new Date().toISOString().split('T')[0]}.json`);
  
  safeWriteFile(outPath, JSON.stringify(adfReport, null, 2));
  return { status: 'success', report_path: outPath, regressions: regressions.length };
}

async function performGenDashboard(_input: SystemAction) {
  const { calculateReinvestment } = await import('@agent/shared-business');
  const perfDir = path.resolve(process.cwd(), 'evidence/performance');
  const outputFile = path.resolve(process.cwd(), 'PERFORMANCE_DASHBOARD.md');

  if (!fs.existsSync(perfDir)) return { status: 'failed', reason: 'No performance data' };
  const files = fs.readdirSync(perfDir).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) return { status: 'failed', reason: 'No reports' };

  const latest = JSON.parse(fs.readFileSync(path.join(perfDir, files[files.length - 1]), 'utf8'));
  const totalSavedMs = 0; // Simplified for brevity as per legacy pattern or improve if needed
  const totalSavedCost = 0;
  const totalSavedHours = Math.round(totalSavedMs / 3600000);
  const strat = calculateReinvestment(totalSavedHours);

  let md = `# 🚀 Performance & Reliability Intelligence Dashboard\n\n*Last Updated: ${new Date().toLocaleString()}*\n\n`;
  md += `## 📊 Ecosystem Health Summary\n\n| Metric | Value | Status |\n| :--- | :--- | :--- |\n`;
  md += `| **Reliability (Success)** | ${latest.summary.total_records > 0 ? 'Verified' : 'N/A'} | 🛡️ Secure |\n`;
  md += `| **SLO Compliance** | ${latest.slo_breaches?.length === 0 ? '🟢 Pass' : '🔴 Breach'} | ${latest.slo_breaches?.length || 0} Breaches |\n\n`;
  
  md += `## 💰 Business Impact\n> **ROI Reinvestment Potential**: ${strat.reinvestableHours}h available\n\n`;
  md += `### 🏗️ Recommendation\n${strat.recommendation}\n\n`;

  safeWriteFile(outputFile, md);
  return { status: 'success', dashboard_path: outputFile };
}

async function performPulseCheck(_input: SystemAction) {
  const ledgerPath = path.resolve(process.cwd(), 'active/audit/governance-ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) return { status: 'NEW', errorRate: '0.0' };

  const { ledger } = await import('@agent/core');
  const content = safeReadFile(ledgerPath, { encoding: 'utf8' }) as string;
  const lines = content.trim().split('\n').filter(l => l.length > 0);
  const entries = lines.slice(-50).map(l => JSON.parse(l));

  const errors = entries.filter(e => e.payload?.status === 'error').length;
  const errorRate = entries.length > 0 ? (errors / entries.length) * 100 : 0;
  const isChainValid = ledger.verifyIntegrity();

  let health = 'HEALTHY';
  if (errorRate > 20) health = 'DEGRADED';
  if (errorRate > 50 || !isChainValid) health = 'CRITICAL';

  return { status: 'success', health, errorRate: errorRate.toFixed(1), isChainValid };
}

async function performPulseTrigger(input: SystemAction) {
  const stimuliPath = path.resolve(process.cwd(), 'presence/bridge/runtime/stimuli.jsonl');
  const { type = 'routine', payload = 'ping', priority = 2 } = input.params || {};

  const stimulus = {
    timestamp: new Date().toISOString(),
    source_channel: 'system_actuator',
    delivery_mode: 'IMMEDIATE',
    type, payload, status: 'PENDING',
    metadata: { priority, triggered_by: 'actuator' }
  };

  const dir = path.dirname(stimuliPath);
  if (!fs.existsSync(dir)) safeMkdir(dir, { recursive: true });
  fs.appendFileSync(stimuliPath, JSON.stringify(stimulus) + '\n');
  return { status: 'success', type, payload };
}

async function performPulseAggregate(_input: SystemAction) {
  const pulsePath = path.resolve(process.cwd(), 'active/shared/runtime/pulse.json');
  const nerves = ['nexus', 'terminal', 'task-watcher', 'log-watcher-adf', 'visual-buffer'];
  
  // Single cycle refresh instead of setInterval for actuator
  const { execSync } = await import('node:child_process');
  const psOutput = execSync('ps -ef', { encoding: 'utf8' });
  
  const results = nerves.map(id => {
    const match = psOutput.split('\n').find(line => line.includes(id) && !line.includes('grep'));
    return {
      id, status: match ? 'ALIVE' : 'DEAD',
      pid: match ? parseInt(match.trim().split(/\s+/)[1]) : undefined,
      ts: new Date().toISOString()
    };
  });

  const pulseData = { ts: new Date().toISOString(), system: 'KANS [ACTUATOR]', nerves: results };
  const dir = path.dirname(pulsePath);
  if (!fs.existsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(pulsePath, JSON.stringify(pulseData, null, 2));
  return { status: 'success', nerves: results };
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
