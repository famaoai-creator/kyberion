#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath, requireArgs } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true, describe: 'Path to SKILL.md file to analyze' })
    .option('out', { alias: 'o', type: 'string', describe: 'Optional output file path' })
    .argv;

/**
 * Required sections that a well-formed SKILL.md should contain.
 */
const REQUIRED_SECTIONS = ['Usage', 'Troubleshooting', 'Options'];

/**
 * Clarity indicators - words/phrases that suggest clear, actionable instructions.
 */
const CLARITY_INDICATORS = [
    'must', 'should', 'returns', 'outputs', 'requires', 'provides',
    'accepts', 'generates', 'validates', 'ensures',
];

/**
 * Actionable language patterns - imperative verbs that guide users.
 */
const ACTIONABLE_PATTERNS = [
    /\b(run|execute|call|invoke|use|pass|specify|provide|set|configure)\b/i,
];

/**
 * Vague words that reduce prompt quality.
 */
const VAGUE_WORDS = [
    'stuff', 'things', 'somehow', 'maybe', 'possibly', 'etc',
    'various', 'certain', 'some kind of', 'sort of',
];

/**
 * Parse YAML-like frontmatter from SKILL.md content.
 */
function parseFrontmatter(content) {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return {};
    const fm = {};
    const lines = match[1].split('\n');
    for (const line of lines) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
            const key = line.substring(0, colonIdx).trim();
            const value = line.substring(colonIdx + 1).trim();
            fm[key] = value;
        }
    }
    return fm;
}

/**
 * Check if content has a specific markdown section (## Section Name).
 */
function hasSection(content, sectionName) {
    const pattern = new RegExp(`^##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
    return pattern.test(content);
}

/**
 * Count the number of headings (sections) in the document.
 */
function _countSections(content) {
    const matches = content.match(/^##\s+.+$/gm);
    return matches ? matches.length : 0;
}

/**
 * Get the body content (everything after frontmatter).
 */
function getBody(content) {
    const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)/);
    return match ? match[1] : content;
}

runSkill('prompt-optimizer', () => {
    requireArgs(argv, ['input']);
    const inputPath = validateFilePath(argv.input, 'input');
    const content = fs.readFileSync(inputPath, 'utf8');
    const frontmatter = parseFrontmatter(content);
    const body = getBody(content);
    const checks = [];
    const suggestions = [];

    // Check 1: Has valid frontmatter with name
    const hasFrontmatterName = !!frontmatter.name;
    checks.push({
        name: 'frontmatter-name',
        passed: hasFrontmatterName,
        detail: hasFrontmatterName
            ? `Name: "${frontmatter.name}"`
            : 'Missing "name" field in frontmatter',
    });
    if (!hasFrontmatterName) {
        suggestions.push('Add a "name" field to the YAML frontmatter (e.g., name: my-skill).');
    }

    // Check 2: Has valid frontmatter with description
    const hasFrontmatterDesc = !!frontmatter.description;
    checks.push({
        name: 'frontmatter-description',
        passed: hasFrontmatterDesc,
        detail: hasFrontmatterDesc
            ? `Description length: ${frontmatter.description.length} chars`
            : 'Missing "description" field in frontmatter',
    });
    if (!hasFrontmatterDesc) {
        suggestions.push('Add a "description" field to the YAML frontmatter.');
    }

    // Check 3: Description length (should be between 20 and 200 chars)
    const descLength = (frontmatter.description || '').length;
    const descLengthOk = descLength >= 20 && descLength <= 200;
    checks.push({
        name: 'description-length',
        passed: descLengthOk,
        detail: descLength > 0
            ? `Description is ${descLength} chars (ideal: 20-200)`
            : 'No description to evaluate',
    });
    if (descLength > 0 && descLength < 20) {
        suggestions.push('Expand the description to at least 20 characters for better clarity.');
    }
    if (descLength > 200) {
        suggestions.push('Shorten the description to 200 characters or less. Move details to the body.');
    }

    // Check 4-6: Required sections
    for (const section of REQUIRED_SECTIONS) {
        const found = hasSection(content, section);
        checks.push({
            name: `section-${section.toLowerCase()}`,
            passed: found,
            detail: found
                ? `"## ${section}" section found`
                : `Missing "## ${section}" section`,
        });
        if (!found) {
            suggestions.push(`Add a "## ${section}" section to improve completeness.`);
        }
    }

    // Check 7: Clarity indicators
    const clarityCount = CLARITY_INDICATORS.filter(word => {
        const pattern = new RegExp(`\\b${word}\\b`, 'i');
        return pattern.test(body);
    }).length;
    const hasClarityIndicators = clarityCount >= 3;
    checks.push({
        name: 'clarity-indicators',
        passed: hasClarityIndicators,
        detail: `Found ${clarityCount}/${CLARITY_INDICATORS.length} clarity indicators (need at least 3)`,
    });
    if (!hasClarityIndicators) {
        suggestions.push(`Use more precise language. Include words like: ${CLARITY_INDICATORS.slice(0, 5).join(', ')}.`);
    }

    // Check 8: Actionable language
    const actionableCount = ACTIONABLE_PATTERNS.filter(pattern => pattern.test(body)).length;
    const hasActionableLanguage = actionableCount > 0;
    checks.push({
        name: 'actionable-language',
        passed: hasActionableLanguage,
        detail: hasActionableLanguage
            ? `Found actionable language patterns (${actionableCount} match(es))`
            : 'No actionable verb patterns found',
    });
    if (!hasActionableLanguage) {
        suggestions.push('Use imperative verbs (run, execute, call, specify, provide) to guide users.');
    }

    // Check 9: No vague words
    const vagueFound = VAGUE_WORDS.filter(word => {
        const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return pattern.test(body);
    });
    const noVagueWords = vagueFound.length === 0;
    checks.push({
        name: 'no-vague-words',
        passed: noVagueWords,
        detail: noVagueWords
            ? 'No vague or imprecise language detected'
            : `Found vague words: ${vagueFound.join(', ')}`,
    });
    if (!noVagueWords) {
        suggestions.push(`Replace vague words (${vagueFound.join(', ')}) with specific, measurable terms.`);
    }

    // Check 10: Knowledge Protocol presence
    const hasKnowledgeProtocol = /knowledge\s*protocol/i.test(content);
    checks.push({
        name: 'knowledge-protocol',
        passed: hasKnowledgeProtocol,
        detail: hasKnowledgeProtocol
            ? 'Knowledge Protocol section or reference found'
            : 'No Knowledge Protocol reference found',
    });
    if (!hasKnowledgeProtocol) {
        suggestions.push('Add a "## Knowledge Protocol" section describing data handling and privacy tiers.');
    }

    // Check 11: Has code examples or usage examples
    const hasExamples = /```[\s\S]*?```/.test(body) || /^\s*[-*]\s+"[^"]+"/m.test(body) || /^\s*[-*]\s+`[^`]+`/m.test(body);
    checks.push({
        name: 'has-examples',
        passed: hasExamples,
        detail: hasExamples
            ? 'Usage examples or code blocks found'
            : 'No concrete examples or code blocks found',
    });
    if (!hasExamples) {
        suggestions.push('Add concrete usage examples (code blocks or quoted commands) to help users understand how to invoke the skill.');
    }

    // Check 12: Sufficient body content (at least 100 chars)
    const bodyLength = body.trim().length;
    const sufficientContent = bodyLength >= 100;
    checks.push({
        name: 'sufficient-content',
        passed: sufficientContent,
        detail: `Body content: ${bodyLength} chars (minimum: 100)`,
    });
    if (!sufficientContent) {
        suggestions.push('Add more detail to the SKILL.md body. Aim for at least 100 characters of descriptive content.');
    }

    const score = checks.filter(c => c.passed).length;
    const maxScore = checks.length;

    const result = {
        file: inputPath,
        score,
        maxScore,
        percentage: Math.round((score / maxScore) * 100),
        checks,
        suggestions,
    };

    if (argv.out) {
        safeWriteFile(argv.out, JSON.stringify(result, null, 2));
    }

    return result;
});
