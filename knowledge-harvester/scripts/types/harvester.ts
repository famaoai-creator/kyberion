/**
 * Type definitions for the knowledge-harvester skill.
 *
 * The knowledge-harvester analyzes a project directory to extract structural
 * metadata, tech stack information, architectural patterns, and documentation
 * summaries. It produces a comprehensive knowledge report about the project.
 *
 * Usage:
 *   import type { HarvestResult, HarvestConfig } from './types/harvester.js';
 */

import type { SkillOutput } from '../../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** CLI arguments accepted by the knowledge-harvester skill. */
export interface HarvestConfig {
  /** Target directory to analyze. */
  dir: string;
  /** Optional output file path for the JSON report. */
  out?: string;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Category of an architectural or project pattern. */
export type PatternType = 'architecture' | 'ci-cd' | 'testing' | 'deployment' | 'quality';

/** A single detected pattern in the project. */
export interface ProjectPattern {
  /** Category of the pattern. */
  type: PatternType;
  /** Human-readable name of the pattern (e.g. "Monorepo (Turborepo)"). */
  name: string;
  /** Additional detail about the detection (e.g. file names, counts). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

/** Summary of a documentation file found in the project. */
export interface DocumentationEntry {
  /** Relative file path (e.g. "README.md", ".github/CODEOWNERS"). */
  file: string;
  /** First-paragraph summary of the file content (up to 300 characters). */
  summary: string;
}

// ---------------------------------------------------------------------------
// Directory Structure
// ---------------------------------------------------------------------------

/** Shallow directory structure summary of the project root. */
export interface StructureSummary {
  /** Sorted list of top-level directory names (suffixed with "/"). */
  directories: string[];
  /** Sorted list of top-level file names. */
  files: string[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Full result data returned by the knowledge-harvester skill. */
export interface HarvestResult {
  /** Absolute path to the analyzed directory. */
  directory: string;
  /** Project name (from package.json "name" field or directory basename). */
  projectName: string;
  /** Detected architectural and project patterns. */
  patterns: ProjectPattern[];
  /** Detected technology stack labels (e.g. "TypeScript", "React", "Docker"). */
  techStack: string[];
  /** Summaries of documentation files found in the project. */
  documentation: DocumentationEntry[];
  /** Total number of non-ignored files in the project. */
  fileCount: number;
  /** Shallow directory structure of the project root. */
  structure: StructureSummary;
  /** Human-readable one-line summary of the harvested knowledge. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Skill Output Envelope
// ---------------------------------------------------------------------------

/** Standard skill-wrapper envelope typed for the knowledge-harvester result. */
export type KnowledgeHarvesterOutput = SkillOutput<HarvestResult>;
