#!/usr/bin/env node
/**
 * Build Size Measurement Script
 *
 * This script measures the size of build artifacts and compares them with previous builds.
 * It generates a detailed report that can be posted as a PR comment.
 *
 * Features:
 * - Measures individual package sizes (actuators, shared packages, scripts)
 * - Compares with previous build sizes
 * - Detects size increases/decreases
 * - Generates formatted report for PR comments
 * - Supports size thresholds and alerts
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

interface PackageSize {
  name: string;
  path: string;
  sizeBytes: number;
  sizeFormatted: string;
}

interface BuildSizeReport {
  timestamp: string;
  commit: string;
  totalSize: number;
  totalSizeFormatted: string;
  packages: PackageSize[];
  actuators: PackageSize[];
  sharedPackages: PackageSize[];
  scripts: PackageSize[];
}

interface SizeComparison {
  current: BuildSizeReport;
  previous?: BuildSizeReport;
  changes: {
    totalDiff: number;
    totalDiffFormatted: string;
    totalDiffPercent: number;
    packageChanges: Array<{
      name: string;
      diff: number;
      diffFormatted: string;
      diffPercent: number;
      status: 'increased' | 'decreased' | 'unchanged' | 'new';
    }>;
  };
}

const HISTORY_FILE = '.kiro/metrics/build-size-history.json';
const THRESHOLD_PERCENT = 10; // Alert if size increases by more than 10%
const THRESHOLD_BYTES = 1024 * 1024; // Alert if size increases by more than 1MB

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Get directory size recursively
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  try {
    const stats = await fs.stat(dirPath);

    if (!stats.isDirectory()) {
      return stats.size;
    }

    const files = await fs.readdir(dirPath);
    const sizes = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(dirPath, file);
        return getDirectorySize(filePath);
      })
    );

    return sizes.reduce((total, size) => total + size, 0);
  } catch (error) {
    // Directory doesn't exist or can't be accessed
    return 0;
  }
}

/**
 * Measure size of a package
 */
async function measurePackage(packagePath: string, name: string): Promise<PackageSize> {
  const sizeBytes = await getDirectorySize(packagePath);
  return {
    name,
    path: packagePath,
    sizeBytes,
    sizeFormatted: formatBytes(sizeBytes),
  };
}

/**
 * Measure all build artifacts
 */
async function measureBuildSize(): Promise<BuildSizeReport> {
  const distPath = 'dist';

  // Check if dist directory exists
  try {
    await fs.access(distPath);
  } catch {
    throw new Error('dist/ directory not found. Please run build first.');
  }

  // Measure actuators
  const actuatorsPath = path.join(distPath, 'libs', 'actuators');
  const actuators: PackageSize[] = [];

  try {
    const actuatorDirs = await fs.readdir(actuatorsPath);
    for (const dir of actuatorDirs) {
      const actuatorPath = path.join(actuatorsPath, dir);
      const stats = await fs.stat(actuatorPath);
      if (stats.isDirectory()) {
        actuators.push(await measurePackage(actuatorPath, dir));
      }
    }
  } catch {
    // Actuators directory doesn't exist
  }

  // Measure shared packages
  const libsPath = path.join(distPath, 'libs');
  const sharedPackages: PackageSize[] = [];

  try {
    const libDirs = await fs.readdir(libsPath);
    for (const dir of libDirs) {
      if (dir.startsWith('shared-')) {
        const packagePath = path.join(libsPath, dir);
        const stats = await fs.stat(packagePath);
        if (stats.isDirectory()) {
          sharedPackages.push(await measurePackage(packagePath, dir));
        }
      }
    }
  } catch {
    // Shared packages directory doesn't exist
  }

  // Measure core
  const corePath = path.join(distPath, 'libs', 'core');
  const corePackage = await measurePackage(corePath, 'core');

  // Measure scripts
  const scriptsPath = path.join(distPath, 'scripts');
  const scripts = await measurePackage(scriptsPath, 'scripts');

  // Calculate total size
  const packages = [corePackage, ...actuators, ...sharedPackages, scripts];
  const totalSize = packages.reduce((sum, pkg) => sum + pkg.sizeBytes, 0);

  // Get commit hash
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    // Git not available or not a git repo
  }

  return {
    timestamp: new Date().toISOString(),
    commit,
    totalSize,
    totalSizeFormatted: formatBytes(totalSize),
    packages,
    actuators,
    sharedPackages,
    scripts: [scripts],
  };
}

/**
 * Load previous build size report
 */
async function loadPreviousReport(): Promise<BuildSizeReport | undefined> {
  try {
    const content = await fs.readFile(HISTORY_FILE, 'utf-8');
    const history = JSON.parse(content);
    return history.reports?.[history.reports.length - 1];
  } catch {
    return undefined;
  }
}

/**
 * Save build size report to history
 */
async function saveReport(report: BuildSizeReport): Promise<void> {
  let history: { version: string; reports: BuildSizeReport[] };

  try {
    const content = await fs.readFile(HISTORY_FILE, 'utf-8');
    history = JSON.parse(content);
  } catch {
    history = { version: '1.0.0', reports: [] };
  }

  history.reports.push(report);

  // Keep only last 50 reports
  if (history.reports.length > 50) {
    history.reports = history.reports.slice(-50);
  }

  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
}

/**
 * Compare current report with previous
 */
function compareReports(current: BuildSizeReport, previous?: BuildSizeReport): SizeComparison {
  if (!previous) {
    return {
      current,
      previous: undefined,
      changes: {
        totalDiff: 0,
        totalDiffFormatted: '0 B',
        totalDiffPercent: 0,
        packageChanges: current.packages.map((pkg) => ({
          name: pkg.name,
          diff: 0,
          diffFormatted: '0 B',
          diffPercent: 0,
          status: 'new' as const,
        })),
      },
    };
  }

  const totalDiff = current.totalSize - previous.totalSize;
  const totalDiffPercent = previous.totalSize > 0 ? (totalDiff / previous.totalSize) * 100 : 0;

  const packageChanges = current.packages.map((currentPkg) => {
    const previousPkg = previous.packages.find((p) => p.name === currentPkg.name);

    if (!previousPkg) {
      return {
        name: currentPkg.name,
        diff: 0,
        diffFormatted: '0 B',
        diffPercent: 0,
        status: 'new' as const,
      };
    }

    const diff = currentPkg.sizeBytes - previousPkg.sizeBytes;
    const diffPercent = previousPkg.sizeBytes > 0 ? (diff / previousPkg.sizeBytes) * 100 : 0;

    let status: 'increased' | 'decreased' | 'unchanged';
    if (Math.abs(diff) < 100) {
      status = 'unchanged';
    } else if (diff > 0) {
      status = 'increased';
    } else {
      status = 'decreased';
    }

    return {
      name: currentPkg.name,
      diff,
      diffFormatted: formatBytes(Math.abs(diff)),
      diffPercent: Math.abs(diffPercent),
      status,
    };
  });

  return {
    current,
    previous,
    changes: {
      totalDiff,
      totalDiffFormatted: formatBytes(Math.abs(totalDiff)),
      totalDiffPercent: Math.abs(totalDiffPercent),
      packageChanges,
    },
  };
}

/**
 * Generate markdown report
 */
function generateMarkdownReport(comparison: SizeComparison): string {
  const { current, previous, changes } = comparison;

  let report = '# 📦 Build Size Report\n\n';

  // Summary
  report += '## Summary\n\n';
  report += `**Total Build Size:** ${current.totalSizeFormatted}\n\n`;

  if (previous) {
    const diffSign = changes.totalDiff >= 0 ? '+' : '-';
    const emoji = changes.totalDiff > 0 ? '📈' : changes.totalDiff < 0 ? '📉' : '➡️';
    report += `**Change from previous build:** ${emoji} ${diffSign}${changes.totalDiffFormatted} (${diffSign}${changes.totalDiffPercent.toFixed(2)}%)\n\n`;

    // Alert if size increased significantly
    if (changes.totalDiff > THRESHOLD_BYTES || changes.totalDiffPercent > THRESHOLD_PERCENT) {
      report += `> ⚠️ **Warning:** Build size increased by more than ${formatBytes(THRESHOLD_BYTES)} or ${THRESHOLD_PERCENT}%\n\n`;
    }
  } else {
    report += '*No previous build data available for comparison*\n\n';
  }

  // Package breakdown
  report += '## Package Sizes\n\n';
  report += '| Package | Size | Change | % |\n';
  report += '|---------|------|--------|---|\n';

  // Sort packages by size (largest first)
  const sortedPackages = [...current.packages].sort((a, b) => b.sizeBytes - a.sizeBytes);

  for (const pkg of sortedPackages) {
    const change = changes.packageChanges.find((c) => c.name === pkg.name);

    if (!change || change.status === 'new') {
      report += `| ${pkg.name} | ${pkg.sizeFormatted} | *new* | - |\n`;
    } else if (change.status === 'unchanged') {
      report += `| ${pkg.name} | ${pkg.sizeFormatted} | - | - |\n`;
    } else {
      const sign = change.status === 'increased' ? '+' : '-';
      const emoji = change.status === 'increased' ? '📈' : '📉';
      report += `| ${pkg.name} | ${pkg.sizeFormatted} | ${emoji} ${sign}${change.diffFormatted} | ${sign}${change.diffPercent.toFixed(2)}% |\n`;
    }
  }

  report += '\n';

  // Category breakdown
  report += '## By Category\n\n';

  const coreSize = current.packages.find((p) => p.name === 'core')?.sizeBytes || 0;
  const actuatorsSize = current.actuators.reduce((sum, a) => sum + a.sizeBytes, 0);
  const sharedSize = current.sharedPackages.reduce((sum, s) => sum + s.sizeBytes, 0);
  const scriptsSize = current.scripts.reduce((sum, s) => sum + s.sizeBytes, 0);

  report += `- **Core:** ${formatBytes(coreSize)}\n`;
  report += `- **Actuators (${current.actuators.length}):** ${formatBytes(actuatorsSize)}\n`;
  report += `- **Shared Packages (${current.sharedPackages.length}):** ${formatBytes(sharedSize)}\n`;
  report += `- **Scripts:** ${formatBytes(scriptsSize)}\n\n`;

  // Metadata
  report += '---\n\n';
  report += `*Measured at: ${new Date(current.timestamp).toLocaleString()}*\n`;
  report += `*Commit: \`${current.commit.substring(0, 7)}\`*\n`;

  return report;
}

/**
 * Generate JSON report for CI
 */
function generateJsonReport(comparison: SizeComparison): string {
  return JSON.stringify(comparison, null, 2);
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const format = args.includes('--json') ? 'json' : 'markdown';
  const saveHistory = !args.includes('--no-save');

  try {
    console.error('📊 Measuring build size...');

    const currentReport = await measureBuildSize();
    const previousReport = await loadPreviousReport();
    const comparison = compareReports(currentReport, previousReport);

    if (saveHistory) {
      await saveReport(currentReport);
      console.error('✅ Build size report saved to history');
    }

    // Output report
    if (format === 'json') {
      console.log(generateJsonReport(comparison));
    } else {
      console.log(generateMarkdownReport(comparison));
    }

    // Exit with error if size increased significantly
    if (
      comparison.changes.totalDiff > THRESHOLD_BYTES ||
      comparison.changes.totalDiffPercent > THRESHOLD_PERCENT
    ) {
      console.error(`\n⚠️  Warning: Build size increased significantly!`);
      // Don't exit with error code - just warn
      // process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error measuring build size:', error);
    process.exit(1);
  }
}

main();
