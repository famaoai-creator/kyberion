import fs from 'fs';
import path from 'path';
import { RiskEntry } from '@agent/core/shared-business-types';

export type Stage = 'seed' | 'series-a' | 'series-b' | 'ipo';

export interface AuditItem {
  category: string;
  items: string[];
}

export interface CategoryResult {
  category: string;
  items: { item: string; status: 'found' | 'missing'; match: string | null }[];
  completion: number;
}

export interface RiskAssessment extends RiskEntry {
  missing: string[];
}

export interface AuditResult {
  directory: string;
  stage: Stage;
  readiness: 'ready' | 'mostly_ready' | 'needs_work' | 'not_ready';
  completionPercent: number;
  itemsFound: number;
  itemsRequired: number;
  categories: CategoryResult[];
  risks: RiskAssessment[];
}

export const DATA_ROOM_CHECKLIST: Record<Stage, { required: AuditItem[] }> = {
  seed: {
    required: [
      {
        category: 'Product',
        items: ['README.md or product overview', 'Working demo or prototype'],
      },
      { category: 'Team', items: ['Team bios or CONTRIBUTORS file'] },
      { category: 'Technical', items: ['Source code repository', 'Basic CI/CD'] },
    ],
  },
  'series-a': {
    required: [
      {
        category: 'Product',
        items: ['README.md or product overview', 'Architecture documentation', 'API documentation'],
      },
      {
        category: 'Technical',
        items: ['Source code repository', 'CI/CD pipeline', 'Test suite', 'Security audit results'],
      },
      { category: 'Financial', items: ['Revenue metrics', 'Cost breakdown', 'Growth projections'] },
      {
        category: 'Legal',
        items: ['LICENSE file', 'Third-party dependency audit', 'Privacy policy'],
      },
    ],
  },
  'series-b': {
    required: [
      {
        category: 'Product',
        items: [
          'README.md or product overview',
          'Architecture documentation',
          'API documentation',
          'Scaling plan',
        ],
      },
      {
        category: 'Technical',
        items: [
          'Source code repository',
          'CI/CD pipeline',
          'Test suite (>70% coverage)',
          'Security audit results',
          'Performance benchmarks',
          'Disaster recovery plan',
        ],
      },
      {
        category: 'Financial',
        items: [
          'Revenue metrics',
          'Unit economics',
          'Cost breakdown',
          'Growth projections',
          'Burn rate analysis',
        ],
      },
      {
        category: 'Legal',
        items: [
          'LICENSE file',
          'SBoM',
          'Compliance certifications',
          'Privacy policy',
          'IP documentation',
        ],
      },
      { category: 'Team', items: ['Org chart', 'Key person dependencies', 'Hiring plan'] },
    ],
  },
  ipo: {
    required: [
      {
        category: 'Product',
        items: [
          'README.md',
          'Architecture documentation',
          'API documentation',
          'Scaling plan',
          'Competitive analysis',
        ],
      },
      {
        category: 'Technical',
        items: [
          'Source code',
          'CI/CD',
          'Test suite (>80%)',
          'Security audit',
          'Performance benchmarks',
          'DR plan',
          'SOC2/ISO27001',
        ],
      },
      {
        category: 'Financial',
        items: [
          'Audited financials',
          'Revenue metrics',
          'Unit economics',
          'Projections',
          'Burn rate',
          'Cap table',
        ],
      },
      {
        category: 'Legal',
        items: [
          'LICENSE',
          'SBoM',
          'All compliance certs',
          'Privacy policy',
          'IP portfolio',
          'Material contracts',
        ],
      },
      {
        category: 'Team',
        items: ['Org chart', 'Key person insurance', 'Board composition', 'Advisory board'],
      },
    ],
  },
};

export function checkItem(dir: string, item: string): { found: boolean; match: string | null } {
  const lower = item.toLowerCase();
  const checks: string[] = [];

  if (lower.includes('readme')) checks.push('README.md', 'README', 'readme.md');
  if (lower.includes('license')) checks.push('LICENSE', 'LICENSE.md', 'LICENCE');
  if (lower.includes('architecture'))
    checks.push('docs/architecture.md', 'ARCHITECTURE.md', 'design/architecture.md');
  if (lower.includes('api doc'))
    checks.push('docs/api.md', 'openapi.yaml', 'swagger.json', 'API.md');
  if (lower.includes('ci/cd') || lower.includes('pipeline'))
    checks.push('.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile');
  if (lower.includes('test suite')) checks.push('tests', 'test', '__tests__', 'spec');
  if (lower.includes('source code')) checks.push('src', 'lib', 'scripts', 'app');
  if (lower.includes('security audit'))
    checks.push('SECURITY.md', 'security-audit.json', 'docs/security.md');
  if (lower.includes('privacy')) checks.push('PRIVACY.md', 'privacy-policy.md');
  if (lower.includes('sbom')) checks.push('sbom.json', 'sbom.xml', 'bom.json');
  if (lower.includes('dr plan') || lower.includes('disaster recovery'))
    checks.push('docs/disaster-recovery.md', 'DR.md');
  if (lower.includes('contributor')) checks.push('CONTRIBUTORS', 'CONTRIBUTORS.md');
  if (lower.includes('changelog')) checks.push('CHANGELOG.md', 'CHANGES.md');
  if (lower.includes('performance')) checks.push('docs/performance.md', 'benchmarks');
  if (lower.includes('compliance') || lower.includes('soc2') || lower.includes('iso27001'))
    checks.push('docs/compliance.md', 'compliance');

  for (const check of checks) {
    const full = path.join(dir, check);
    if (fs.existsSync(full)) return { found: true, match: check };
  }

  return { found: false, match: null };
}

export function auditDataRoom(dir: string, stage: Stage) {
  const checklist = DATA_ROOM_CHECKLIST[stage];
  const results: CategoryResult[] = [];
  let totalItems = 0;
  let foundItems = 0;

  for (const category of checklist.required) {
    const categoryResults: CategoryResult['items'] = [];
    for (const item of category.items) {
      totalItems++;
      const check = internals.checkItem(dir, item);
      if (check.found) foundItems++;
      categoryResults.push({
        item,
        status: check.found ? 'found' : 'missing',
        match: check.match,
      });
    }
    results.push({
      category: category.category,
      items: categoryResults,
      completion: Math.round(
        (categoryResults.filter((r) => r.status === 'found').length / categoryResults.length) * 100
      ),
    });
  }

  return {
    results,
    totalItems,
    foundItems,
    completionPercent: totalItems > 0 ? Math.round((foundItems / totalItems) * 100) : 0,
  };
}

export function assessRisks(
  audit: { results: CategoryResult[]; completionPercent: number },
  stage: Stage
): RiskAssessment[] {
  const risks: RiskAssessment[] = [];
  const importanceMap: Record<string, string> = {
    Product: 'Demonstrates product-market fit and technical viability.',
    Technical: 'Essential for verifying security, scalability, and code quality.',
    Financial: 'Critical for valuation and verifying growth potential.',
    Legal: 'Ensures IP protection and compliance with regulations.',
    Team: 'Validates execution capability and key person risks.',
  };

  for (const cat of audit.results) {
    const missing = cat.items.filter((i) => i.status === 'missing');
    if (missing.length > 0) {
      const severity: RiskAssessment['severity'] =
        cat.category === 'Legal' || cat.category === 'Financial' ? 'high' : 'medium';
      risks.push({
        id: `missing-${cat.category.toLowerCase()}`,
        title: `Missing ${cat.category} Evidence`,
        category: cat.category,
        severity,
        missing: missing.map((m) => m.item),
        risk: `${missing.length} missing item(s) in ${cat.category}.`,
        impact: importanceMap[cat.category] || 'General preparation risk.',
      });
    }
  }

  if (audit.completionPercent < 50) {
    risks.push({
      id: 'overall-readiness',
      title: 'Critically Low Readiness',
      category: 'Overall',
      severity: 'critical',
      missing: [],
      risk: `Extremely low readiness (${audit.completionPercent}%).`,
      impact: `Project is not prepared for the ${stage} stage.`,
    });
  }
  return risks;
}

export const internals = {
  checkItem,
  auditDataRoom,
  assessRisks,
};

export function processAudit(dir: string, stage: Stage): AuditResult {
  const audit = internals.auditDataRoom(dir, stage);
  const risks = internals.assessRisks(audit, stage);

  let readiness: AuditResult['readiness'] = 'not_ready';
  if (audit.completionPercent >= 90) readiness = 'ready';
  else if (audit.completionPercent >= 70) readiness = 'mostly_ready';
  else if (audit.completionPercent >= 50) readiness = 'needs_work';

  return {
    directory: dir,
    stage,
    readiness,
    completionPercent: audit.completionPercent,
    itemsFound: audit.foundItems,
    itemsRequired: audit.totalItems,
    categories: audit.results,
    risks,
  };
}
