import { safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAllFiles } from '@agent/core/fs-utils';
import * as pathResolver from '@agent/core/path-resolver';

export const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs', '.py', '.rb', '.go', '.rs', '.java', '.cs', '.php', '.swift', '.kt', '.scala', '.vue', '.svelte',
]);

export const TEST_PATTERNS = [
  /\.test\.[a-z]+$/i, /\.spec\.[a-z]+$/i, /_test\.[a-z]+$/i, /test_[^/]+\.[a-z]+$/i, /\.tests\.[a-z]+$/i,
];

export const TEST_DIR_PATTERNS = [
  /^tests?$/i, /^__tests__$/i, /^spec$/i, /^specs$/i, /^test-suite$/i,
];

export interface FrameworkDetector {
  name: string; configFiles: string[]; packageKeys?: string[]; packageDevDeps?: string[]; markerInConfig?: string[]; filePattern?: RegExp;
}

export const FRAMEWORK_DETECTORS: FrameworkDetector[] = [
  { name: 'jest', configFiles: ['jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs'], packageKeys: ['jest'], packageDevDeps: ['jest', '@jest/core', 'ts-jest'] },
  { name: 'vitest', configFiles: ['vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs'], packageDevDeps: ['vitest'] },
  { name: 'mocha', configFiles: ['.mocharc.yml', '.mocharc.yaml', '.mocharc.json', '.mocharc.js', '.mocharc.cjs'], packageDevDeps: ['mocha'] },
  { name: 'pytest', configFiles: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'conftest.py'], markerInConfig: ['[tool.pytest', '[pytest]'] },
  { name: 'playwright', configFiles: ['playwright.config.js', 'playwright.config.ts'], packageDevDeps: ['@playwright/test'] },
  { name: 'cypress', configFiles: ['cypress.config.js', 'cypress.config.ts', 'cypress.json'], packageDevDeps: ['cypress'] },
  { name: 'jasmine', configFiles: ['jasmine.json', 'spec/support/jasmine.json'], packageDevDeps: ['jasmine', 'jasmine-core'] },
  { name: 'rspec', configFiles: ['.rspec', 'spec/spec_helper.rb'] },
  { name: 'go-test', configFiles: [], filePattern: /_test\.go$/ },
  { name: 'cargo-test', configFiles: ['Cargo.toml'], markerInConfig: ['[dev-dependencies]'] },
];

export interface TestAnalysis {
  frameworks: string[]; testFiles: string[]; sourceFiles: string[]; testRatio: number; untested: string[]; strategy: TestStrategy; recommendations: string[];
}

export interface TestStrategy { recommendedFramework: string; coverageTarget: number; estimatedEffort: string; }

function loadStandards() {
  const pathStd = pathResolver.knowledge('skills/engineering/test-suite-architect/standards.json');
  if (!fs.existsSync(pathStd)) {
    // Return minimal defaults if standards file is missing (e.g. during tests)
    return {
      strategy: {
        default_coverage_target: 80,
        tiers: [],
        untested_thresholds: { high_effort: 50, medium_effort: 10 }
      },
      recommendation_thresholds: { low_test_ratio: 0.2 }
    };
  }
  return JSON.parse(safeReadFile(pathStd, { encoding: 'utf8' }) as string);
}

export function isTestFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  const dirParts = filePath.split(path.sep);
  const inTestDir = dirParts.some((part) => TEST_DIR_PATTERNS.some((p) => p.test(part)));
  const matchesPattern = TEST_PATTERNS.some((p) => p.test(basename));
  return inTestDir || matchesPattern;
}

export function isSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(ext)) return false;
  return !isTestFile(filePath);
}

export function detectFrameworks(projectDir: string, allFiles: string[]): string[] {
  const detected: string[] = [];
  const fileNames = new Set(allFiles.map((f) => path.relative(projectDir, f)));
  const basenames = new Set(allFiles.map((f) => path.basename(f)));
  let pkgJson: any = null;
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try { pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_err) {}
  }

  for (const detector of FRAMEWORK_DETECTORS) {
    let found = false;
    if (detector.configFiles) { for (const cfg of detector.configFiles) { if (fileNames.has(cfg) || basenames.has(cfg)) { found = true; break; } } }
    if (!found && pkgJson) {
      if (detector.packageKeys) { for (const key of detector.packageKeys) { if (pkgJson[key]) { found = true; break; } } }
      if (!found && detector.packageDevDeps) {
        const deps = { ...(pkgJson.devDependencies || {}), ...(pkgJson.dependencies || {}) };
        for (const dep of detector.packageDevDeps) { if (deps[dep]) { found = true; break; } }
      }
    }
    if (!found && detector.markerInConfig) {
      for (const cfgFile of detector.configFiles || []) {
        const cfgPath = path.join(projectDir, cfgFile);
        if (fs.existsSync(cfgPath)) {
          try {
            const cfgContent = fs.readFileSync(cfgPath, 'utf8');
            for (const marker of detector.markerInConfig) { if (cfgContent.includes(marker)) { found = true; break; } }
          } catch (_err) {}
        }
        if (found) break;
      }
    }
    if (!found && detector.filePattern) { for (const file of basenames) { if (detector.filePattern.test(file)) { found = true; break; } } }
    if (found) detected.push(detector.name);
  }
  return detected;
}

export function findUntestedFiles(sourceFiles: string[], testFiles: string[], projectDir: string): string[] {
  const testBasenames = new Set();
  for (const tf of testFiles) {
    const bn = path.basename(tf);
    const cleaned = bn.replace(/\.test\./i, '.').replace(/\.spec\./i, '.').replace(/_test\./i, '.').replace(/^test_/i, '');
    testBasenames.add(cleaned.toLowerCase());
  }
  const untested: string[] = [];
  for (const sf of sourceFiles) {
    const bn = path.basename(sf).toLowerCase();
    if (!testBasenames.has(bn)) untested.push(path.relative(projectDir, sf));
  }
  return untested;
}

export function generateStrategy(frameworks: string[], testRatio: number, untested: string[], sourceFiles: string[], testFiles: string[]): TestStrategy {
  const standards = loadStandards();
  let recommendedFramework = frameworks.length > 0 ? frameworks[0] : 'jest';
  if (frameworks.length === 0) {
    if (sourceFiles.some(f => f.endsWith('.py'))) recommendedFramework = 'pytest';
    else if (sourceFiles.some(f => f.endsWith('.rs'))) recommendedFramework = 'cargo-test';
    else if (sourceFiles.some(f => f.endsWith('.go'))) recommendedFramework = 'go-test';
  }
  let coverageTarget = standards.strategy.default_coverage_target;
  let estimatedEffort = 'low';
  for (const tier of standards.strategy.tiers) {
    if (tier.max_ratio !== undefined && testRatio < tier.max_ratio) { coverageTarget = tier.target; estimatedEffort = tier.effort; break; }
    if (tier.min_ratio !== undefined && testRatio >= tier.min_ratio) { coverageTarget = tier.target; estimatedEffort = tier.effort || estimatedEffort; }
  }
  if (untested.length > standards.strategy.untested_thresholds.high_effort) estimatedEffort = 'high';
  else if (untested.length > standards.strategy.untested_thresholds.medium_effort) estimatedEffort = 'medium';
  return { recommendedFramework, coverageTarget, estimatedEffort };
}

export function analyzeTestSuite(projectDir: string): TestAnalysis {
  const standards = loadStandards();
  let allFiles: string[] = [];
  try {
    allFiles = getAllFiles(projectDir, { maxDepth: 10 });
  } catch (_e) {}
  
  const testFiles = allFiles.filter((f) => isTestFile(f));
  const sourceFiles = allFiles.filter((f) => isSourceFile(f));
  const frameworks = detectFrameworks(projectDir, allFiles);
  const testRatio = sourceFiles.length > 0 ? testFiles.length / sourceFiles.length : 0;
  const untested = findUntestedFiles(sourceFiles, testFiles, projectDir);
  const strategy = generateStrategy(frameworks, testRatio, untested, sourceFiles, testFiles);
  const recommendations: string[] = [];
  if (frameworks.length > 0) recommendations.push('Detected framework(s): ' + frameworks.join(', '));
  else recommendations.push('No test framework detected - recommend adopting ' + strategy.recommendedFramework);
  if (testRatio < standards.recommendation_thresholds.low_test_ratio) { recommendations.push('Test ratio low at ' + (testRatio * 100).toFixed(1) + '%'); }
  return { frameworks, testFiles: testFiles.map(f => path.relative(projectDir, f)), sourceFiles: sourceFiles.map(f => path.relative(projectDir, f)), testRatio: Math.round(testRatio * 1000) / 1000, untested: untested.slice(0, 50), strategy, recommendations };
}
