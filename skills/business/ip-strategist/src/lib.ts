import fs from 'fs';
import path from 'path';
import { getAllFiles } from '@agent/core/fs-utils';
import { StrategicAction, RiskEntry } from '@agent/core/shared-business-types';

export interface IPFinding {
  file: string;
  category: string;
  patentable: boolean;
  matchCount: number;
  samples: string[];
}

export interface LicenseProtection {
  protected: boolean;
  license: string | null;
  file?: string;
  risk: 'low' | 'medium' | 'high';
}

export interface IPPortfolio {
  algorithms: number;
  protocols: number;
  tradeSecrets: number;
}

export interface IPStrategyResult {
  directory: string;
  totalFindings: number;
  patentableItems: number;
  findings: IPFinding[];
  licenseProtection: LicenseProtection;
  ipPortfolio: IPPortfolio;
  recommendations: StrategicAction[];
  risks?: RiskEntry[];
}

export const IP_INDICATORS = [
  {
    pattern:
      /(?:algorithm|heuristic|model|neural|machine.learning|deep.learning|transformer|inference|optimization)/gi,
    category: 'Algorithm/Model',
    patentable: true,
  },
  {
    pattern: /(?:patent|trademark|copyright|intellectual.property|ip.asset|proprietary.right)/gi,
    category: 'IP Reference',
    patentable: false,
  },
  {
    pattern: /(?:proprietary|trade.secret|confidential|novel|non.public|under.wraps)/gi,
    category: 'Trade Secret',
    patentable: false,
  },
  {
    pattern: /(?:unique|innovative|first.of.its.kind|breakthrough|inventive|state.of.the.art)/gi,
    category: 'Innovation Claim',
    patentable: true,
  },
  {
    pattern:
      /(?:protocol|specification|standard|format|interface.standard|specification.compliance)/gi,
    category: 'Protocol/Standard',
    patentable: true,
  },
];

export function scanForIP(dir: string): IPFinding[] {
  const findings: IPFinding[] = [];
  const allFiles = getAllFiles(dir, { maxDepth: 4 });
  for (const full of allFiles) {
    const ext = path.extname(full);
    if (!['.js', '.cjs', '.ts', '.py', '.go', '.rs', '.java', '.md'].includes(ext)) {
      continue;
    }

    try {
      const content = fs.readFileSync(full, 'utf8');
      for (const indicator of IP_INDICATORS) {
        const matches = content.match(indicator.pattern);
        if (matches && matches.length > 0) {
          findings.push({
            file: path.relative(dir, full),
            category: indicator.category,
            patentable: indicator.patentable,
            matchCount: matches.length,
            samples: [...new Set(matches)].slice(0, 3),
          });
        }
      }
    } catch (_e) {
      /* ignore read errors */
    }
  }
  return findings;
}

export function checkLicenseProtection(dir: string): LicenseProtection {
  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENCE'].find((f) =>
    fs.existsSync(path.join(dir, f))
  );

  if (!licenseFile) {
    return { protected: false, license: null, risk: 'high' };
  }

  const content = fs.readFileSync(path.join(dir, licenseFile), 'utf8');
  let type = 'unknown';
  if (/MIT/i.test(content)) type = 'MIT (permissive)';
  else if (/Apache/i.test(content)) type = 'Apache 2.0 (permissive with patent grant)';
  else if (/GPL/i.test(content)) type = 'GPL (copyleft)';
  else if (/BSD/i.test(content)) type = 'BSD (permissive)';
  else if (/proprietary|all rights reserved/i.test(content)) type = 'Proprietary';

  return {
    protected: true,
    license: type,
    file: licenseFile,
    risk: type.includes('permissive') ? 'medium' : 'low',
  };
}

export function processIPStrategy(dir: string): IPStrategyResult {
  const findings = scanForIP(dir);
  const license = checkLicenseProtection(dir);
  const patentable = findings.filter((f) => f.patentable);

  const recommendations: StrategicAction[] = [];
  const risks: RiskEntry[] = [];

  if (!license.protected) {
    risks.push({
      category: 'Legal',
      severity: 'critical',
      risk: 'Intellectual property is unprotected due to missing LICENSE file.',
      impact: 'Risk of uncontrolled redistribution or loss of proprietary rights.',
    });
    recommendations.push({
      action: 'Create a LICENSE file immediately (Proprietary or OSS)',
      priority: 'critical',
      area: 'Legal',
    });
  }

  if (patentable.length > 0) {
    recommendations.push({
      action: `Perform IP review for ${patentable.length} potentially patentable items`,
      priority: 'high',
      area: 'IP Strategy',
      expectedImpact: 'Protection of core innovation and competitive advantage.',
    });
  }

  return {
    directory: dir,
    totalFindings: findings.length,
    patentableItems: patentable.length,
    findings: findings.slice(0, 30),
    licenseProtection: license,
    ipPortfolio: {
      algorithms: findings.filter((f) => f.category === 'Algorithm/Model').length,
      protocols: findings.filter((f) => f.category === 'Protocol/Standard').length,
      tradeSecrets: findings.filter((f) => f.category === 'Trade Secret').length,
    },
    recommendations,
    risks,
  };
}
