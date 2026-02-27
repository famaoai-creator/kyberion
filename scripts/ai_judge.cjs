#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

/**
 * ai_judge.cjs
 * Grades mission outcomes based on persona-specific criteria.
 * In a real scenario, this would call an LLM. 
 * For YOLO mode, we implement the scoring logic framework.
 */

const rootDir = path.resolve(__dirname, '..');

const PERSONA_CRITERIA = {
  'Ruthless Auditor': { weight: 1.2, focus: 'Risk & Compliance' },
  'Pragmatic CTO': { weight: 1.0, focus: 'Efficiency & Scalability' },
  'Empathetic CXO': { weight: 0.8, focus: 'UX & Accessibility' },
  'Ecosystem Architect': { weight: 1.1, focus: 'Structural Integrity' },
  'Security Reviewer': { weight: 1.3, focus: 'Security & PII' }
};

function judge(missionDir) {
  const missionId = path.basename(missionDir);
  const reportPath = path.join(missionDir, 'ace-report.json');
  const logPath = path.join(missionDir, 'execution.log');

  if (!fs.existsSync(reportPath)) return null;

  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    let logContent = '';
    if (fs.existsSync(logPath)) {
      logContent = fs.readFileSync(logPath, 'utf8');
    }

    // Determine the judge persona based on mission domain or role
    const assignedRole = report.role || 'Ecosystem Architect';
    let judgePersona = 'Ecosystem Architect';
    
    if (assignedRole.includes('Security')) judgePersona = 'Security Reviewer';
    else if (assignedRole.includes('PMO') || assignedRole.includes('Auditor')) judgePersona = 'Ruthless Auditor';
    else if (assignedRole.includes('Developer') || assignedRole.includes('CTO')) judgePersona = 'Pragmatic CTO';
    else if (assignedRole.includes('Designer')) judgePersona = 'Empathetic CXO';

    const criteria = PERSONA_CRITERIA[judgePersona];
    
    // Heuristic Scoring Logic
    let baseScore = report.status === 'success' ? 85 : 40;
    
    // Penalty for errors in log
    const errorCount = (logContent.match(/ERROR/g) || []).length;
    baseScore -= errorCount * 5;

    // Bonus for specific success patterns
    if (logContent.includes('Victory Conditions Met')) baseScore += 10;
    if (logContent.includes('Self-evolution triggered')) baseScore += 5;

    const finalScore = Math.max(0, Math.min(100, Math.round(baseScore * criteria.weight)));
    
    let grade = 'F';
    if (finalScore >= 90) grade = 'S';
    else if (finalScore >= 80) grade = 'A';
    else if (finalScore >= 70) grade = 'B';
    else if (finalScore >= 60) grade = 'C';
    else if (finalScore >= 40) grade = 'D';

    const evaluation = {
      missionId,
      judge: judgePersona,
      focus: criteria.focus,
      score: finalScore,
      grade,
      comments: generateJudgeComment(judgePersona, grade, isSuccess(report, logContent)),
      timestamp: new Date().toISOString()
    };

    const evalPath = path.join(missionDir, 'ai-evaluation.json');
    fs.writeFileSync(evalPath, JSON.stringify(evaluation, null, 2));
    
    return evaluation;
  } catch (err) {
    console.error(`[AI-Judge] Error evaluating ${missionId}: ${err.message}`);
    return null;
  }
}

function isSuccess(report, log) {
  return report.status === 'success' || log.includes('[SUCCESS]');
}

function generateJudgeComment(persona, grade, success) {
  const comments = {
    'Ruthless Auditor': {
      S: 'Risks are fully mitigated. Evidence is airtight. Acceptable.',
      C: 'Weak evidence. High residual risk. Improvement required.',
      F: 'Total failure. Compliance breach imminent.'
    },
    'Pragmatic CTO': {
      S: 'Highly efficient execution. Code/Artifact is production-ready.',
      C: 'Technically functional but messy. Refactoring needed.',
      F: 'Inefficient approach. Failed to deliver business value.'
    },
    'Ecosystem Architect': {
      S: 'Perfect alignment with ecosystem standards. Clean abstraction.',
      C: 'Violates naming conventions or directory structure. Fix it.',
      F: 'Architectural chaos. Revert and rethink.'
    }
  };

  const personaComments = comments[persona] || comments['Pragmatic CTO'];
  if (grade === 'S' || grade === 'A') return personaComments.S;
  if (grade === 'B' || grade === 'C') return personaComments.C;
  return personaComments.F;
}

if (require.main === module) {
  const target = process.argv[2];
  if (target && fs.existsSync(target)) {
    const result = judge(target);
    if (result) console.log(`[JUDGE] Mission ${result.missionId} graded: ${result.grade} (${result.score}/100) by ${result.judge}`);
  }
}

module.exports = { judge };
