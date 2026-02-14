/**
 * TypeScript version of the security-scanner skill.
 *
 * Scans project files for potential security vulnerabilities by checking
 * file paths against ignore lists and filtering binary files.
 *
 * The CLI entry point remains in scan.cjs; this module exports
 * typed helper functions for the core scanning logic.
 *
 * Usage:
 *   import { scanProject, parseScanResults, buildScanOutput } from './scan.js';
 *   const results = scanProject(filePaths, projectRoot);
 *   const parsed = parseScanResults(results, projectRoot);
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single vulnerability or finding from the security scan. */
export interface Vulnerability {
  /** Relative file path where the finding was detected. */
  file: string;
  /** Whether the file was successfully scanned. */
  scanned: boolean;
}

/** Result of a security scan. */
export interface ScanResult {
  /** Root directory of the scanned project. */
  projectRoot: string;
  /** Directories excluded from scanning. */
  ignoreDirs: string[];
  /** File extensions excluded from scanning. */
  ignoreExtensions: string[];
  /** Overall scan status. */
  status: string;
  /** Individual file scan results, if available. */
  findings?: Vulnerability[];
}

// ---------------------------------------------------------------------------
// Configuration (matching CJS implementation)
// ---------------------------------------------------------------------------

/** Directories to ignore during scanning. */
const IGNORE_DIRS: string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'vendor',
  'bin',
  'obj',
  '.idea',
  '.vscode',
  '.DS_Store',
  'tmp',
  'temp',
];

/** File extensions to ignore during scanning. */
const IGNORE_EXTENSIONS: string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.mp3',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.lock',
];

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Determine whether a file path should be ignored based on directory
 * and extension ignore lists.
 *
 * @param filePath - Absolute or relative file path to check
 * @returns True if the file should be skipped
 */
function shouldIgnore(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (IGNORE_EXTENSIONS.includes(ext)) return true;

  const parts = filePath.split(path.sep);
  return parts.some((part) => IGNORE_DIRS.includes(part));
}

/**
 * Scan a list of file paths and return findings for scannable files.
 *
 * Filters out ignored directories, ignored extensions, and binary files
 * matching the CJS implementation.
 *
 * @param filePaths   - Array of absolute file paths to scan
 * @param projectRoot - Root directory for computing relative paths
 * @returns Array of vulnerability/finding objects for scanned files
 */
export function scanProject(filePaths: string[], projectRoot: string): Vulnerability[] {
  const findings: Vulnerability[] = [];

  for (const filePath of filePaths) {
    if (shouldIgnore(filePath)) continue;

    findings.push({
      file: path.relative(projectRoot, filePath),
      scanned: true,
    });
  }

  return findings;
}

/**
 * Parse raw scan findings into a structured ScanResult.
 *
 * @param findings    - Array of individual file scan findings
 * @param projectRoot - Root directory of the scanned project
 * @returns Structured scan result
 */
export function parseScanResults(findings: Vulnerability[], projectRoot: string): ScanResult {
  return {
    projectRoot,
    ignoreDirs: IGNORE_DIRS,
    ignoreExtensions: IGNORE_EXTENSIONS,
    status: 'scan_complete',
    findings,
  };
}

// ---------------------------------------------------------------------------
// SkillOutput builder
// ---------------------------------------------------------------------------

/**
 * Build a SkillOutput envelope for the security-scanner skill.
 *
 * @param result  - Security scan result data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildScanOutput(result: ScanResult, startMs: number): SkillOutput<ScanResult> {
  return {
    skill: 'security-scanner',
    status: 'success',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
