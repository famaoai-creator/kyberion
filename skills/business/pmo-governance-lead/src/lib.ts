import fs from 'fs';
import path from 'path';
import { RiskEntry } from '@agent/core/shared-business-types';

export interface EvidenceConfig {
  type: 'file' | 'dir';
  patterns: string[];
  label: string;
}

export interface QualityGate {
  name: string;
  evidence: EvidenceConfig[];
  weight: number;
}

export interface EvidenceResult {
  label: string;
  status: 'found' | 'missing';
  match: string | null;
}

export interface PhaseResult {
  phase: string;
  completion: number;
  status: 'ready' | 'partial' | 'not_ready';
  evidence: EvidenceResult[];
}

/**
 * Audit-specific risk, compliant with shared RiskEntry.
 */
export interface GovernanceRisk extends RiskEntry {
  phase: string;
}

export interface GovernanceResult {
  directory: string;
  overallCompletion: number;
  overallStatus: 'ready' | 'partial' | 'not_ready';
  phases: PhaseResult[];
  risks: GovernanceRisk[];
  highRiskCount: number;
}

export const QUALITY_GATES: Record<string, QualityGate> = {
  requirements: {
    name: 'Requirements Phase',
    evidence: [
      {
        type: 'file',
        patterns: ['**/requirements*.md', '**/PRD*.md', '**/specs/**', '**/requirements*.yaml'],
        label: 'Requirements Document',
      },
      {
        type: 'file',
        patterns: ['**/stakeholder*', '**/meeting-notes*'],
        label: 'Stakeholder Sign-off',
      },
    ],
    weight: 20,
  },
  design: {
    name: 'Design Phase',
    evidence: [
      {
        type: 'file',
        patterns: ['**/design*.md', '**/architecture*.md', '**/diagrams/**', '**/ADR*'],
        label: 'Design Document / ADR',
      },
      {
        type: 'file',
        patterns: ['**/schema*', '**/erd*', '**/openapi*', '**/swagger*'],
        label: 'Schema / API Design',
      },
    ],
    weight: 20,
  },
  implementation: {
    name: 'Implementation Phase',
    evidence: [
      { type: 'dir', patterns: ['src/', 'lib/', 'app/', 'scripts/'], label: 'Source Code' },
      { type: 'file', patterns: ['.gitignore', '.editorconfig'], label: 'Development Standards' },
      {
        type: 'file',
        patterns: ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md'],
        label: 'Contributing Guidelines',
      },
    ],
    weight: 20,
  },
  testing: {
    name: 'Testing Phase',
    evidence: [
      {
        type: 'dir',
        patterns: ['tests/', 'test/', '__tests__/', 'spec/', 'e2e/'],
        label: 'Test Suite',
      },
      {
        type: 'file',
        patterns: ['jest.config*', 'vitest.config*', 'pytest.ini', '.rspec', 'cypress.config*'],
        label: 'Test Configuration',
      },
      {
        type: 'file',
        patterns: ['**/coverage/**', '.c8rc*', '.nycrc*', 'codecov*'],
        label: 'Coverage Configuration',
      },
    ],
    weight: 20,
  },
  deployment: {
    name: 'Deployment Phase',
    evidence: [
      {
        type: 'file',
        patterns: ['.github/workflows/*', '.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml'],
        label: 'CI/CD Pipeline',
      },
      {
        type: 'file',
        patterns: ['Dockerfile', 'docker-compose*', 'k8s/**', 'terraform/**'],
        label: 'Infrastructure Config',
      },
      { type: 'file', patterns: ['CHANGELOG.md', 'RELEASE*'], label: 'Release Documentation' },
    ],
    weight: 20,
  },
};

export function searchRecursive(
  dir: string,
  filePattern: string,
  maxDepth: number,
  depth = 0
): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  const regex = new RegExp('^' + filePattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isFile() && regex.test(entry.name)) {
        results.push(path.join(dir, entry.name));
      } else if (entry.isDirectory()) {
        results.push(
          ...searchRecursive(path.join(dir, entry.name), filePattern, maxDepth, depth + 1)
        );
      }
    }
  } catch (_e) {
    /* skip */
  }
  return results;
}

export function simpleGlob(dir: string, pattern: string): string[] {
  const parts = pattern.split('/');
  const fileName = parts[parts.length - 1];
  const hasWildDir = parts.some((p) => p === '**');

  try {
    if (hasWildDir) {
      return searchRecursive(dir, fileName, 3);
    }
    const targetDir = parts.length > 1 ? path.join(dir, ...parts.slice(0, -1)) : dir;
    if (!fs.existsSync(targetDir)) return [];
    const files = fs.readdirSync(targetDir);
    const regex = new RegExp('^' + fileName.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    return files.filter((f) => regex.test(f)).map((f) => path.join(targetDir, f));
  } catch (_e) {
    return [];
  }
}

export function checkEvidence(
  dir: string,
  evidence: EvidenceConfig
): { found: boolean; match: string | null; quality?: 'low' | 'high' } {
  for (const pattern of evidence.patterns) {
    if (evidence.type === 'dir') {
      const dirPath = path.join(dir, pattern.replace('/', ''));
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        const stats = fs.statSync(dirPath);
        // Simple quality check: recently updated?
        const isRecent = Date.now() - stats.mtimeMs < 30 * 24 * 60 * 60 * 1000; // 30 days
        return { found: true, match: pattern, quality: isRecent ? 'high' : 'low' };
      }
    } else {
      const matches = simpleGlob(dir, pattern);
      if (matches.length > 0) {
        const stats = fs.statSync(matches[0]);
        const isSignificant = stats.size > 100; // More than 100 bytes
        return {
          found: true,
          match: path.relative(dir, matches[0]),
          quality: isSignificant ? 'high' : 'low',
        };
      }
    }
  }
  return { found: false, match: null };
}

export function auditPhase(dir: string, phaseKey: string): PhaseResult {
  const gate = QUALITY_GATES[phaseKey];
  const results: EvidenceResult[] = [];
  let passed = 0;

  for (const evidence of gate.evidence) {
    const check = internals.checkEvidence(dir, evidence);
    results.push({
      label: evidence.label,
      status: check.found ? 'found' : 'missing',
      match: check.match,
    });
    if (check.found) passed++;
  }

  const completion =
    gate.evidence.length > 0 ? Math.round((passed / gate.evidence.length) * 100) : 0;

  return {
    phase: gate.name,
    completion,
    status: completion >= 100 ? 'ready' : completion >= 50 ? 'partial' : 'not_ready',
    evidence: results,
  };
}

export function identifyRisks(phaseResults: PhaseResult[]): GovernanceRisk[] {
  const risks: GovernanceRisk[] = [];

  for (const phase of phaseResults) {
    if (phase.status === 'not_ready') {
      risks.push({
        id: `insufficient-evidence-${phase.phase.toLowerCase().replace(/ /g, '-')}`,
        title: `Insufficient Evidence: ${phase.phase}`,
        category: 'Governance',
        severity: 'high',
        phase: phase.phase,
        risk: `${phase.phase} has insufficient evidence (${phase.completion}% complete)`,
        impact: 'Increased risk of project failure or quality degradation.',
      });
    }
    const missing = phase.evidence.filter((e) => e.status === 'missing');
    for (const m of missing) {
      risks.push({
        id: `missing-evidence-${m.label.toLowerCase().replace(/ /g, '-')}`,
        title: `Missing Evidence: ${m.label}`,
        category: 'Evidence',
        severity: phase.completion < 50 ? 'high' : 'medium',
        phase: phase.phase,
        risk: `Missing evidence for: ${m.label}`,
        impact: 'Traceability gap in SDLC.',
      });
    }
  }

  return risks;
}

export function processGovernanceAudit(dir: string, phaseFilter: string): GovernanceResult {
  const phases = phaseFilter === 'all' ? Object.keys(QUALITY_GATES) : [phaseFilter];
  const phaseResults = phases.map((p) => internals.auditPhase(dir, p));
  const risks = internals.identifyRisks(phaseResults);

  const totalCompletion =
    phaseResults.length > 0
      ? Math.round(phaseResults.reduce((s, p) => s + p.completion, 0) / phaseResults.length)
      : 0;

  let overallStatus: GovernanceResult['overallStatus'] = 'not_ready';
  if (totalCompletion >= 80) overallStatus = 'ready';
  else if (totalCompletion >= 50) overallStatus = 'partial';

  return {
    directory: dir,
    overallCompletion: totalCompletion,
    overallStatus,
    phases: phaseResults,
    risks,
    highRiskCount: risks.filter((r) => r.severity === 'high').length,
  };
}

export const internals = {
  checkEvidence,
  auditPhase,
  identifyRisks,
};
