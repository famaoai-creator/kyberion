#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');


const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs',
  '.py', '.rb', '.go', '.rs', '.java', '.cs',
  '.php', '.swift', '.kt', '.scala', '.vue', '.svelte',
]);

const TEST_PATTERNS = [
  /\.test\.[a-z]+$/i,
  /\.spec\.[a-z]+$/i,
  /_test\.[a-z]+$/i,
  /test_[^/]+\.[a-z]+$/i,
  /\.tests\.[a-z]+$/i,
];

const TEST_DIR_PATTERNS = [
  /^tests?$/i,
  /^__tests__$/i,
  /^spec$/i,
  /^specs$/i,
  /^test-suite$/i,
];

/**
 * Framework detection rules: config files and package.json indicators.
 */
const FRAMEWORK_DETECTORS = [
  {
    name: 'jest',
    configFiles: ['jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs'],
    packageKeys: ['jest'],
    packageDevDeps: ['jest', '@jest/core', 'ts-jest'],
  },
  {
    name: 'vitest',
    configFiles: ['vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs'],
    packageDevDeps: ['vitest'],
  },
  {
    name: 'mocha',
    configFiles: ['.mocharc.yml', '.mocharc.yaml', '.mocharc.json', '.mocharc.js', '.mocharc.cjs'],
    packageDevDeps: ['mocha'],
  },
  {
    name: 'pytest',
    configFiles: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'conftest.py'],
    markerInConfig: ['[tool.pytest', '[pytest]'],
  },
  {
    name: 'playwright',
    configFiles: ['playwright.config.js', 'playwright.config.ts'],
    packageDevDeps: ['@playwright/test'],
  },
  {
    name: 'cypress',
    configFiles: ['cypress.config.js', 'cypress.config.ts', 'cypress.json'],
    packageDevDeps: ['cypress'],
  },
  {
    name: 'ava',
    configFiles: [],
    packageDevDeps: ['ava'],
  },
  {
    name: 'tape',
    configFiles: [],
    packageDevDeps: ['tape'],
  },
  {
    name: 'jasmine',
    configFiles: ['jasmine.json', 'spec/support/jasmine.json'],
    packageDevDeps: ['jasmine', 'jasmine-core'],
  },
  {
    name: 'rspec',
    configFiles: ['.rspec', 'spec/spec_helper.rb'],
  },
  {
    name: 'go-test',
    configFiles: [],
    filePattern: /_test\.go$/,
  },
  {
    name: 'cargo-test',
    configFiles: ['Cargo.toml'],
    markerInConfig: ['[dev-dependencies]'],
  },
];

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    demandOption: true,
    describe: 'Path to project directory to analyze',
  })
  .check((parsed) => {
    const resolved = path.resolve(parsed.dir);
    if (!fs.existsSync(resolved)) {
      throw new Error('Directory not found: ' + resolved);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error('Path is not a directory: ' + resolved);
    }
    return true;
  })
  .strict()
  .help()
  .argv;

/**
 * Check if a file is a test file based on name patterns and directory.
 */
function isTestFile(filePath) {
  const basename = path.basename(filePath);
  const dirParts = filePath.split(path.sep);

  // Check if file is in a test directory
  const inTestDir = dirParts.some(part => TEST_DIR_PATTERNS.some(p => p.test(part)));

  // Check if filename matches test patterns
  const matchesPattern = TEST_PATTERNS.some(p => p.test(basename));

  return inTestDir || matchesPattern;
}

/**
 * Check if a file is a source file (non-test, code file).
 */
function isSourceFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(ext)) {
    return false;
  }
  return !isTestFile(filePath);
}

/**
 * Detect test frameworks from config files and package.json.
 */
function detectFrameworks(projectDir, allFiles) {
  const detected = [];
  const fileNames = new Set(allFiles.map(f => path.relative(projectDir, f)));
  const basenames = new Set(allFiles.map(f => path.basename(f)));

  // Check package.json
  let pkgJson = null;
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (_err) {
      // ignore parse errors
    }
  }

  for (const detector of FRAMEWORK_DETECTORS) {
    let found = false;

    // Check config files
    if (detector.configFiles) {
      for (const cfg of detector.configFiles) {
        if (fileNames.has(cfg) || basenames.has(cfg)) {
          found = true;
          break;
        }
      }
    }

    // Check package.json keys and devDependencies
    if (!found && pkgJson) {
      if (detector.packageKeys) {
        for (const key of detector.packageKeys) {
          if (pkgJson[key]) {
            found = true;
            break;
          }
        }
      }
      if (!found && detector.packageDevDeps) {
        const deps = { ...(pkgJson.devDependencies || {}), ...(pkgJson.dependencies || {}) };
        for (const dep of detector.packageDevDeps) {
          if (deps[dep]) {
            found = true;
            break;
          }
        }
      }
    }

    // Check for markers in config files
    if (!found && detector.markerInConfig) {
      for (const cfgFile of (detector.configFiles || [])) {
        const cfgPath = path.join(projectDir, cfgFile);
        if (fs.existsSync(cfgPath)) {
          try {
            const cfgContent = fs.readFileSync(cfgPath, 'utf8');
            for (const marker of detector.markerInConfig) {
              if (cfgContent.includes(marker)) {
                found = true;
                break;
              }
            }
          } catch (_err) {
            // ignore
          }
        }
        if (found) break;
      }
    }

    if (found) {
      detected.push(detector.name);
    }
  }

  return detected;
}

/**
 * Find source files that lack corresponding test files.
 */
function findUntestedFiles(sourceFiles, testFiles, projectDir) {
  const testBasenames = new Set();
  for (const tf of testFiles) {
    // Extract the base name without test suffix
    const bn = path.basename(tf);
    const cleaned = bn
      .replace(/\.test\./i, '.')
      .replace(/\.spec\./i, '.')
      .replace(/_test\./i, '.')
      .replace(/^test_/i, '');
    testBasenames.add(cleaned.toLowerCase());
  }

  const untested = [];
  for (const sf of sourceFiles) {
    const bn = path.basename(sf).toLowerCase();
    if (!testBasenames.has(bn)) {
      untested.push(path.relative(projectDir, sf));
    }
  }

  return untested;
}

/**
 * Generate a test strategy with recommendations.
 */
function generateStrategy(frameworks, testRatio, untested, sourceFiles, testFiles) {
  const recommendations = [];

  // Framework recommendation
  let recommendedFramework = 'jest';
  if (frameworks.length > 0) {
    recommendedFramework = frameworks[0];
    recommendations.push('Detected framework: ' + frameworks.join(', ') + ' - continue using ' + frameworks[0]);
  } else {
    const hasPython = sourceFiles.some(f => f.endsWith('.py'));
    const hasRust = sourceFiles.some(f => f.endsWith('.rs'));
    const hasGo = sourceFiles.some(f => f.endsWith('.go'));

    if (hasPython) {
      recommendedFramework = 'pytest';
    } else if (hasRust) {
      recommendedFramework = 'cargo-test';
    } else if (hasGo) {
      recommendedFramework = 'go-test';
    }

    recommendations.push('No test framework detected - recommend adopting ' + recommendedFramework);
  }

  // Coverage targets
  let coverageTarget = 80;
  if (testRatio < 0.1) {
    coverageTarget = 50;
    recommendations.push('Very low test ratio (' + (testRatio * 100).toFixed(1) + '%) - start with 50% coverage target');
  } else if (testRatio < 0.3) {
    coverageTarget = 70;
    recommendations.push('Low test ratio (' + (testRatio * 100).toFixed(1) + '%) - aim for 70% coverage target');
  } else if (testRatio >= 0.5) {
    coverageTarget = 90;
    recommendations.push('Good test ratio (' + (testRatio * 100).toFixed(1) + '%) - aim for 90% coverage target');
  } else {
    recommendations.push('Moderate test ratio (' + (testRatio * 100).toFixed(1) + '%) - aim for 80% coverage target');
  }

  // Untested files
  if (untested.length > 0) {
    const topUntested = untested.slice(0, 5);
    recommendations.push('Priority: add tests for ' + topUntested.join(', ') + (untested.length > 5 ? ' and ' + (untested.length - 5) + ' more' : ''));
  }

  if (testFiles.length === 0) {
    recommendations.push('No test files found - create initial test suite with ' + recommendedFramework);
  }

  return {
    recommendedFramework,
    coverageTarget,
    estimatedEffort: untested.length > 20 ? 'high' : untested.length > 5 ? 'medium' : 'low',
  };
}

runSkill('test-suite-architect', () => {
  const projectDir = path.resolve(argv.dir);
  const allFiles = getAllFiles(projectDir, { maxDepth: 10 });

  const testFiles = allFiles.filter(f => isTestFile(f));
  const sourceFiles = allFiles.filter(f => isSourceFile(f));
  const frameworks = detectFrameworks(projectDir, allFiles);
  const testRatio = sourceFiles.length > 0 ? testFiles.length / sourceFiles.length : 0;
  const untested = findUntestedFiles(sourceFiles, testFiles, projectDir);
  const strategy = generateStrategy(frameworks, testRatio, untested, sourceFiles, testFiles);

  const recommendations = [];
  if (frameworks.length > 0) {
    recommendations.push('Detected framework(s): ' + frameworks.join(', '));
  } else {
    recommendations.push('No test framework detected - recommend adopting ' + strategy.recommendedFramework);
  }
  if (testRatio < 0.3) {
    recommendations.push('Test-to-source ratio is low at ' + (testRatio * 100).toFixed(1) + '% - prioritize adding tests');
  }
  if (untested.length > 0) {
    recommendations.push(untested.length + ' source file(s) appear to lack corresponding tests');
  }

  return {
    framework: frameworks,
    testFiles: testFiles.map(f => path.relative(projectDir, f)),
    sourceFiles: sourceFiles.map(f => path.relative(projectDir, f)),
    testRatio: Math.round(testRatio * 1000) / 1000,
    untested: untested.slice(0, 50),
    strategy,
    recommendations,
  };
});