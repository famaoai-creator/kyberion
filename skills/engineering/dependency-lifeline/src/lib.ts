import * as fs from 'fs';
import * as path from 'path';
import { safeWriteFile } from '@agent/core/secure-io';

// Known deprecated packages
const DEPRECATED_PACKAGES = new Set([
  'request',
  'request-promise',
  'request-promise-native',
  'tslint',
  'istanbul',
  'nomnom',
  'coffee-script',
  'jade',
  'bower',
  'grunt-cli',
  'gulp-util',
  'domutils',
  'natives',
  'left-pad',
  'merge',
]);

// Security-related packages
const SECURITY_PACKAGES = new Set([
  'helmet',
  'cors',
  'csurf',
  'express-rate-limit',
  'jsonwebtoken',
  'bcrypt',
  'bcryptjs',
  'crypto-js',
  'passport',
  'express-session',
  'cookie-parser',
  'hpp',
  'xss-clean',
  'express-mongo-sanitize',
]);

export interface DependencyResult {
  name: string;
  specified: string;
  installed: string;
  source: string;
  status: string;
  risk: string;
  updateType: string | null;
  deprecated: boolean;
  securityRelated: boolean;
}

export interface LifelineReport {
  project: string;
  totalDeps: number;
  outdated: number;
  upToDate: number;
  majorUpdates: number;
  minorUpdates: number;
  patchUpdates: number;
  notInstalled: number;
  healthScore: number;
  dependencies: DependencyResult[];
  recommendations: string[];
}

export function parseSemver(
  version: string
): { major: number; minor: number; patch: string } | null {
  if (!version) return null;
  const cleaned = version.replace(/^[~^>=<\s]+/, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(.+)$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: match[3],
  };
}

export function compareVersions(
  specified: string,
  installed: string
): { status: string; risk: string; updateType: string | null } {
  const specParsed = parseSemver(specified);
  const instParsed = parseSemver(installed);

  if (!specParsed || !instParsed) {
    return { status: 'unknown', risk: 'unknown', updateType: null };
  }

  if (instParsed.major > specParsed.major)
    return { status: 'outdated', risk: 'high', updateType: 'major' };
  if (instParsed.major < specParsed.major)
    return { status: 'outdated', risk: 'high', updateType: 'major' }; // Downgrade or mismatch

  if (instParsed.minor > specParsed.minor)
    return { status: 'outdated', risk: 'medium', updateType: 'minor' };
  if (instParsed.minor < specParsed.minor)
    return { status: 'outdated', risk: 'medium', updateType: 'minor' };

  const specPatch = parseInt(specParsed.patch, 10);
  const instPatch = parseInt(instParsed.patch, 10);

  if (!isNaN(specPatch) && !isNaN(instPatch) && specPatch !== instPatch) {
    return { status: 'outdated', risk: 'low', updateType: 'patch' };
  }

  return { status: 'up-to-date', risk: 'none', updateType: null };
}

function getInstalledVersion(projectDir: string, pkgName: string): string | null {
  const pkgJsonPath = path.join(projectDir, 'node_modules', pkgName, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;
  try {
    const content = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    return content.version || null;
  } catch (_e) {
    return null;
  }
}

function generateRecommendations(
  depResults: DependencyResult[],
  counts: Record<string, number>
): string[] {
  const recommendations: string[] = [];

  if (counts.majorUpdates > 0) {
    const majorPkgs = depResults.filter((d) => d.updateType === 'major').map((d) => d.name);
    recommendations.push(
      `${counts.majorUpdates} package(s) have major version differences (${majorPkgs.join(', ')}). Review changelogs for breaking changes before updating.`
    );
  }

  if (counts.minorUpdates > 0) {
    recommendations.push(
      `${counts.minorUpdates} package(s) have minor version differences. These are generally safe to update but should be tested.`
    );
  }

  if (counts.patchUpdates > 0) {
    recommendations.push(
      `${counts.patchUpdates} package(s) have patch version differences. These typically contain bug fixes and are safe to update.`
    );
  }

  const deprecatedFound = depResults.filter((d) => d.deprecated);
  if (deprecatedFound.length > 0) {
    recommendations.push(
      `${deprecatedFound.length} deprecated package(s) detected (${deprecatedFound.map((d) => d.name).join(', ')}). Find and migrate to maintained alternatives.`
    );
  }

  const securityPkgs = depResults.filter((d) => d.securityRelated && d.status === 'outdated');
  if (securityPkgs.length > 0) {
    recommendations.push(
      `${securityPkgs.length} outdated security-related package(s) (${securityPkgs.map((d) => d.name).join(', ')}). Prioritize updating these immediately.`
    );
  }

  const notInstalled = depResults.filter((d) => d.status === 'not-installed');
  if (notInstalled.length > 0) {
    recommendations.push(
      `${notInstalled.length} package(s) not found in node_modules. Run "npm install" to ensure all dependencies are available.`
    );
  }

  if (recommendations.length === 0) {
    recommendations.push('All dependencies appear healthy and up to date.');
  }

  return recommendations;
}

export function analyzeDependencies(projectDir: string, outputFile?: string): LifelineReport {
  const pkgJsonPath = path.join(projectDir, 'package.json');

  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`package.json not found in ${projectDir}`);
  }

  let pkgJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse package.json: ${msg}`);
  }

  // Collect all dependencies
  const allDeps: Record<string, { version: string; source: string }> = {};
  const depSources = ['dependencies', 'devDependencies', 'peerDependencies'];
  for (const source of depSources) {
    if (pkgJson[source] && typeof pkgJson[source] === 'object') {
      for (const [name, version] of Object.entries(pkgJson[source])) {
        if (typeof version === 'string') {
          allDeps[name] = { version, source };
        }
      }
    }
  }

  const depNames = Object.keys(allDeps);
  if (depNames.length === 0) {
    throw new Error('No dependencies found in package.json.');
  }

  const counts = {
    outdated: 0,
    upToDate: 0,
    majorUpdates: 0,
    minorUpdates: 0,
    patchUpdates: 0,
    notInstalled: 0,
    unknown: 0,
  };

  const depResults: DependencyResult[] = depNames.map((name) => {
    const specified = allDeps[name].version;
    const source = allDeps[name].source;
    const installed = getInstalledVersion(projectDir, name);
    const deprecated = DEPRECATED_PACKAGES.has(name);
    const securityRelated = SECURITY_PACKAGES.has(name);

    let status;
    let risk;
    let updateType: string | null = null;

    if (!installed) {
      status = 'not-installed';
      risk = 'unknown';
      counts.notInstalled++;
    } else {
      const comparison = compareVersions(specified, installed);
      status = comparison.status;
      risk = comparison.risk;
      updateType = comparison.updateType;

      if (status === 'outdated') {
        counts.outdated++;
        if (updateType === 'major') counts.majorUpdates++;
        else if (updateType === 'minor') counts.minorUpdates++;
        else if (updateType === 'patch') counts.patchUpdates++;
      } else if (status === 'up-to-date') {
        counts.upToDate++;
      } else {
        counts.unknown++;
      }
    }

    // Elevate risk for deprecated or security packages
    if (deprecated && risk !== 'high') {
      risk = 'high';
    }
    if (securityRelated && status === 'outdated' && risk === 'low') {
      risk = 'medium';
    }

    return {
      name,
      specified,
      installed: installed || 'N/A',
      source,
      status,
      risk,
      updateType,
      deprecated,
      securityRelated,
    };
  });

  // Calculate health score (0-100)
  const totalAnalyzed = depNames.length;
  let healthScore = 100;

  healthScore -= counts.majorUpdates * 15;
  healthScore -= counts.minorUpdates * 5;
  healthScore -= counts.patchUpdates * 2;
  healthScore -= counts.notInstalled * 10;
  healthScore -= depResults.filter((d) => d.deprecated).length * 20;

  healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

  const recommendations = generateRecommendations(depResults, counts);

  const report: LifelineReport = {
    project: pkgJson.name || path.basename(projectDir),
    totalDeps: totalAnalyzed,
    outdated: counts.outdated,
    upToDate: counts.upToDate,
    majorUpdates: counts.majorUpdates,
    minorUpdates: counts.minorUpdates,
    patchUpdates: counts.patchUpdates,
    notInstalled: counts.notInstalled,
    healthScore,
    dependencies: depResults,
    recommendations,
  };

  if (outputFile) {
    safeWriteFile(outputFile, JSON.stringify(report, null, 2));
  }

  return report;
}
