/**
 * TypeScript version of the requirements-wizard skill.
 *
 * Evaluates a requirements document against a standards-based checklist
 * (IPA, IEEE, or Agile) and scores completeness by keyword matching.
 *
 * The CLI entry point remains in main.cjs; this module exports
 * typed helper functions for the core evaluation logic.
 *
 * Usage:
 *   import { evaluateCheck, scoreRequirements, CHECKLISTS } from './main.js';
 *   const result = scoreRequirements(documentContent, 'ipa');
 */

import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported requirements standard names. */
export type StandardName = 'ipa' | 'ieee' | 'agile';

/** A single checklist item consisting of a section name and matching keywords. */
export interface ChecklistItem {
  name: string;
  keywords: string[];
}

/** Result of evaluating a single checklist item against document content. */
export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** Overall result of requirements scoring. */
export interface RequirementsResult {
  standard: StandardName;
  score: number;
  totalChecks: number;
  passedChecks: number;
  checks: CheckResult[];
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Checklist definitions
// ---------------------------------------------------------------------------

/** Checklist definitions matching the CJS implementation. */
export const CHECKLISTS: Record<StandardName, ChecklistItem[]> = {
  ipa: [
    {
      name: 'scope',
      keywords: ['scope', 'objective', 'goal', 'purpose', 'target', 'boundary', 'boundaries'],
    },
    {
      name: 'stakeholders',
      keywords: ['stakeholder', 'user', 'actor', 'role', 'customer', 'client', 'sponsor', 'owner'],
    },
    {
      name: 'functional requirements',
      keywords: [
        'functional requirement',
        'function',
        'feature',
        'use case',
        'user story',
        'capability',
        'shall',
      ],
    },
    {
      name: 'non-functional requirements',
      keywords: [
        'non-functional',
        'nonfunctional',
        'performance',
        'reliability',
        'availability',
        'scalability',
        'security',
        'maintainability',
        'usability',
      ],
    },
    {
      name: 'constraints',
      keywords: [
        'constraint',
        'limitation',
        'restriction',
        'assumption',
        'dependency',
        'prerequisite',
      ],
    },
    {
      name: 'glossary',
      keywords: ['glossary', 'definition', 'terminology', 'term', 'acronym', 'abbreviation'],
    },
    {
      name: 'acceptance criteria',
      keywords: [
        'acceptance criteria',
        'acceptance test',
        'done',
        'definition of done',
        'verification',
        'validation',
        'success criteria',
      ],
    },
  ],
  ieee: [
    {
      name: 'introduction',
      keywords: ['introduction', 'purpose', 'scope', 'overview', 'document conventions'],
    },
    {
      name: 'overall description',
      keywords: [
        'overall description',
        'product perspective',
        'product functions',
        'user characteristics',
        'operating environment',
      ],
    },
    {
      name: 'external interfaces',
      keywords: [
        'external interface',
        'user interface',
        'hardware interface',
        'software interface',
        'communication interface',
      ],
    },
    {
      name: 'system features',
      keywords: [
        'system feature',
        'functional requirement',
        'feature',
        'use case',
        'stimulus',
        'response',
      ],
    },
    {
      name: 'non-functional requirements',
      keywords: [
        'non-functional',
        'performance',
        'safety',
        'security',
        'reliability',
        'availability',
      ],
    },
    {
      name: 'data requirements',
      keywords: [
        'data requirement',
        'data model',
        'entity',
        'database',
        'schema',
        'data dictionary',
      ],
    },
    { name: 'appendices', keywords: ['appendix', 'appendices', 'glossary', 'index', 'reference'] },
  ],
  agile: [
    {
      name: 'user stories',
      keywords: ['user story', 'as a', 'i want', 'so that', 'story', 'epic'],
    },
    {
      name: 'acceptance criteria',
      keywords: ['acceptance criteria', 'given', 'when', 'then', 'scenario', 'done'],
    },
    {
      name: 'personas',
      keywords: ['persona', 'user type', 'actor', 'role', 'stakeholder', 'archetype'],
    },
    {
      name: 'priority',
      keywords: [
        'priority',
        'must have',
        'should have',
        'could have',
        'moscow',
        'backlog',
        'sprint',
      ],
    },
    {
      name: 'definition of done',
      keywords: ['definition of done', 'done', 'complete', 'ready', 'dod'],
    },
    {
      name: 'non-functional requirements',
      keywords: ['non-functional', 'performance', 'scalability', 'security', 'quality attribute'],
    },
    {
      name: 'constraints',
      keywords: ['constraint', 'limitation', 'budget', 'timeline', 'technical debt', 'dependency'],
    },
  ],
};

// ---------------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------------

/**
 * Check if a document section is present by searching for keywords.
 *
 * @param content   - Document content (already lowercased)
 * @param checkItem - Checklist item with name and keywords
 * @returns Evaluation result for this check
 */
export function evaluateCheck(content: string, checkItem: ChecklistItem): CheckResult {
  const foundKeywords = checkItem.keywords.filter((kw) => content.includes(kw.toLowerCase()));
  const passed = foundKeywords.length > 0;

  let detail: string;
  if (passed) {
    detail = `Found keywords: ${foundKeywords.join(', ')}`;
  } else {
    detail = `No keywords found. Expected one of: ${checkItem.keywords.join(', ')}`;
  }

  return {
    name: checkItem.name,
    passed,
    detail,
  };
}

/**
 * Score a requirements document against a standard checklist.
 *
 * @param rawContent - The raw document text (will be lowercased internally)
 * @param standard   - The standard to score against ('ipa', 'ieee', or 'agile')
 * @returns Scoring result with checks, score, and recommendations
 * @throws {Error} If the standard name is not recognised
 */
export function scoreRequirements(rawContent: string, standard: StandardName): RequirementsResult {
  const checklist = CHECKLISTS[standard];
  if (!checklist) {
    throw new Error(
      `Unknown standard: ${standard}. Supported: ${Object.keys(CHECKLISTS).join(', ')}`
    );
  }

  const content = rawContent.toLowerCase();

  // Evaluate each check
  const checks = checklist.map((item) => evaluateCheck(content, item));
  const passedChecks = checks.filter((c) => c.passed).length;
  const totalChecks = checks.length;
  const score = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

  // Generate recommendations for failed checks
  const recommendations = checks
    .filter((c) => !c.passed)
    .map((c) => `Add a "${c.name}" section to improve document completeness.`);

  return {
    standard,
    score,
    totalChecks,
    passedChecks,
    checks,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// SkillOutput builder
// ---------------------------------------------------------------------------

/**
 * Build a SkillOutput envelope for the requirements-wizard skill.
 *
 * @param result  - Requirements scoring result data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildRequirementsOutput(
  result: RequirementsResult,
  startMs: number
): SkillOutput<RequirementsResult> {
  return {
    skill: 'requirements-wizard',
    status: 'success',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
