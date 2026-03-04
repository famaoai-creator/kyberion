import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import fs from 'fs';
import path from 'path';
import { getAllFiles } from '@agent/core/fs-utils';
import { StrategicAction, RiskEntry } from '@agent/core/shared-business-types';

export interface IPFinding {
  file: string; category: string; patentable: boolean; matchCount: number; samples: string[];
}

export interface LicenseProtection {
  protected: boolean; license: string | null; file?: string; risk: 'low' | 'medium' | 'high';
}

export interface IPPortfolio { algorithms: number; protocols: number; tradeSecrets: number; }

export interface IPStrategyResult {
  directory: string; totalFindings: number; patentableItems: number; findings: IPFinding[];
  licenseProtection: LicenseProtection; ipPortfolio: IPPortfolio; recommendations: StrategicAction[]; risks?: RiskEntry[];
}

function loadIntel() {
  const root = process.cwd();
  const langPath = path.resolve(root, 'knowledge/common/language-standards.json');
  const ipPath = path.resolve(root, 'knowledge/skills/business/ip-strategist/indicators.json');
  return {
    langs: JSON.parse(fs.readFileSync(langPath, 'utf8')),
    ip: JSON.parse(fs.readFileSync(ipPath, 'utf8'))
  };
}

export function scanForIP(dir: string): IPFinding[] {
  const intel = loadIntel();
  const findings: IPFinding[] = [];
  const allFiles = getAllFiles(dir, { maxDepth: 4 });
  const allowedExts = [...intel.langs.supported_extensions.code, ...intel.langs.supported_extensions.document];

  for (const full of allFiles) {
    if (!allowedExts.includes(path.extname(full))) continue;
    try {
      const content = fs.readFileSync(full, 'utf8');
      for (const indicator of intel.ip.indicators) {
        const regex = new RegExp(indicator.pattern, 'gi');
        const matches = content.match(regex);
        if (matches && matches.length > 0) {
          findings.push({
            file: path.relative(dir, full),
            category: indicator.category,
            patentable: indicator.patentable,
            matchCount: matches.length,
            samples: [...new Set(matches as string[])].slice(0, 3),
          });
        }
      }
    } catch (_e) { /* ignore */ }
  }
  return findings;
}

export function checkLicenseProtection(dir: string): LicenseProtection {
  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENCE'].find((f) => fs.existsSync(path.join(dir, f)));
  if (!licenseFile) return { protected: false, license: null, risk: 'high' };
  const content = fs.readFileSync(path.join(dir, licenseFile), 'utf8');
  let type = 'unknown';
  if (/MIT/i.test(content)) type = 'MIT';
  else if (/Apache/i.test(content)) type = 'Apache 2.0';
  else if (/GPL/i.test(content)) type = 'GPL';
  else if (/proprietary/i.test(content)) type = 'Proprietary';
  return { protected: true, license: type, file: licenseFile, risk: type.includes('Proprietary') ? 'low' : 'medium' };
}

export function processIPStrategy(dir: string): IPStrategyResult {
  const findings = scanForIP(dir);
  const license = checkLicenseProtection(dir);
  const patentable = findings.filter((f) => f.patentable);
  const recommendations: StrategicAction[] = [];
  const risks: RiskEntry[] = [];

  if (!license.protected) {
    risks.push({ 
      id: 'missing-license',
      title: 'IP at Risk: Missing License',
      category: 'Legal', 
      severity: 'critical', 
      risk: 'IP unprotected', 
      impact: 'Loss of rights' 
    });
    recommendations.push({ action: 'Create LICENSE', priority: 'critical', area: 'Legal' });
  }
  return {
    directory: dir, totalFindings: findings.length, patentableItems: patentable.length,
    findings: findings.slice(0, 30), licenseProtection: license,
    ipPortfolio: {
      algorithms: findings.filter((f) => f.category === 'Algorithm/Model').length,
      protocols: findings.filter((f) => f.category === 'Protocol/Standard').length,
      tradeSecrets: findings.filter((f) => f.category === 'Trade Secret').length,
    },
    recommendations, risks,
  };
}
