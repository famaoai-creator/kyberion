#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath, requireArgs } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true, describe: 'Path to source file to analyze' })
    .option('out', { alias: 'o', type: 'string', describe: 'Optional output file path' })
    .argv;

/**
 * Thresholds for code smell detection.
 */
const THRESHOLDS = {
    maxFunctionLength: 50,   // lines
    maxNestingDepth: 4,      // levels
    maxLineLength: 120,      // characters
    magicNumberMin: 2,       // ignore 0 and 1
};

/**
 * Common magic number exceptions (not considered smells).
 */
const MAGIC_NUMBER_EXCEPTIONS = new Set([
    '0', '1', '-1', '2', '100', '1000',
    '0.0', '1.0', '0.5',
    '200', '201', '204', '301', '302', '400', '401', '403', '404', '500', // HTTP status codes
]);

/**
 * Detect long functions (>50 lines).
 * Supports function declarations, arrow functions, and methods.
 */
function detectLongFunctions(lines) {
    const smells = [];
    const functionPatterns = [
        /^\s*(async\s+)?function\s+(\w+)\s*\(/,
        /^\s*(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(.*\)\s*=>/,
        /^\s*(const|let|var)\s+(\w+)\s*=\s*(async\s+)?function\s*\(/,
        /^\s*(\w+)\s*\(.*\)\s*\{/,
    ];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        let functionName = null;

        for (const pattern of functionPatterns) {
            const match = line.match(pattern);
            if (match) {
                // Extract function name from different capture groups
                functionName = match[2] || match[1] || '(anonymous)';
                if (functionName === 'async' || functionName === 'const' || functionName === 'let' || functionName === 'var') {
                    functionName = match[2] || '(anonymous)';
                }
                break;
            }
        }

        if (functionName && line.includes('{')) {
            // Count the function body length using brace matching
            let braceDepth = 0;
            const functionStart = i;
            let j = i;
            let started = false;

            while (j < lines.length) {
                const currentLine = lines[j];
                for (const ch of currentLine) {
                    if (ch === '{') { braceDepth++; started = true; }
                    if (ch === '}') { braceDepth--; }
                }
                if (started && braceDepth === 0) {
                    const functionLength = j - functionStart + 1;
                    if (functionLength > THRESHOLDS.maxFunctionLength) {
                        smells.push({
                            type: 'long-function',
                            line: functionStart + 1,
                            detail: `Function "${functionName}" is ${functionLength} lines (max: ${THRESHOLDS.maxFunctionLength})`,
                            severity: functionLength > THRESHOLDS.maxFunctionLength * 2 ? 'high' : 'medium',
                        });
                    }
                    break;
                }
                j++;
            }
        }
        i++;
    }

    return smells;
}

/**
 * Detect deep nesting (>4 levels).
 */
function detectDeepNesting(lines) {
    const smells = [];
    const nestingKeywords = /^\s*(if|else|for|while|switch|try|catch)\b/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Calculate indentation-based nesting level
        const leadingSpaces = line.match(/^(\s*)/)[1];
        const tabCount = (leadingSpaces.match(/\t/g) || []).length;
        const spaceCount = (leadingSpaces.match(/ /g) || []).length;
        // Estimate nesting: tabs count as 1 level, every 2-4 spaces count as 1 level
        const _estimatedDepth = tabCount + Math.floor(spaceCount / 2);

        // Also check brace-based nesting
        if (nestingKeywords.test(line) || line.trim().endsWith('{')) {
            // Count opening braces up to this line
            let braceDepth = 0;
            for (let j = 0; j <= i; j++) {
                for (const ch of lines[j]) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }
            }
            if (braceDepth > THRESHOLDS.maxNestingDepth) {
                smells.push({
                    type: 'deep-nesting',
                    line: i + 1,
                    detail: `Nesting depth ${braceDepth} exceeds maximum of ${THRESHOLDS.maxNestingDepth}`,
                    severity: braceDepth > THRESHOLDS.maxNestingDepth + 2 ? 'high' : 'medium',
                });
            }
        }
    }

    return smells;
}

/**
 * Detect long lines (>120 chars).
 */
function detectLongLines(lines) {
    const smells = [];
    for (let i = 0; i < lines.length; i++) {
        const lineLength = lines[i].length;
        if (lineLength > THRESHOLDS.maxLineLength) {
            smells.push({
                type: 'long-line',
                line: i + 1,
                detail: `Line is ${lineLength} chars (max: ${THRESHOLDS.maxLineLength})`,
                severity: 'low',
            });
        }
    }
    return smells;
}

/**
 * Detect duplicate code patterns (consecutive lines that repeat).
 */
function detectDuplicatePatterns(lines) {
    const smells = [];
    const blockSize = 3; // Look for blocks of 3+ identical consecutive lines
    const seen = new Map();

    for (let i = 0; i <= lines.length - blockSize; i++) {
        const block = [];
        for (let j = 0; j < blockSize; j++) {
            block.push(lines[i + j].trim());
        }
        // Skip empty or trivial blocks
        if (block.every(l => l === '' || l === '{' || l === '}' || l === ''));
        if (block.join('').trim().length < 20) continue;

        const key = block.join('\n');
        if (seen.has(key)) {
            const firstOccurrence = seen.get(key);
            // Only report once per duplicate pair
            if (!smells.some(s => s.type === 'duplicate-code' && s.detail.includes(`lines ${firstOccurrence}`))) {
                smells.push({
                    type: 'duplicate-code',
                    line: i + 1,
                    detail: `Duplicate code block (${blockSize} lines) also found at lines ${firstOccurrence}-${firstOccurrence + blockSize - 1}`,
                    severity: 'medium',
                });
            }
        } else {
            seen.set(key, i + 1);
        }
    }

    return smells;
}

/**
 * Detect magic numbers in code.
 */
function detectMagicNumbers(lines) {
    const smells = [];
    const magicNumberPattern = /(?<!\w)(-?\d+\.?\d*)\b/g;
    const ignoreLinePatterns = [
        /^\s*\/\//,           // single-line comments
        /^\s*\*/,             // block comment lines
        /^\s*import\b/,       // import statements
        /^\s*require\b/,      // require statements
        /^\s*(const|let|var)\s+\w+\s*=\s*['"`]/, // string assignments
        /\.port\s*[=:]/i,     // port assignments
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments and certain line types
        if (ignoreLinePatterns.some(p => p.test(line))) continue;

        let match;
        while ((match = magicNumberPattern.exec(line)) !== null) {
            const numStr = match[1];
            if (MAGIC_NUMBER_EXCEPTIONS.has(numStr)) continue;
            // Skip if it's part of an array index or common pattern
            const beforeChar = line[match.index - 1] || '';
            if (beforeChar === '[' || beforeChar === '.') continue;

            smells.push({
                type: 'magic-number',
                line: i + 1,
                detail: `Magic number ${numStr} found - consider extracting to a named constant`,
                severity: 'low',
            });
        }
    }

    return smells;
}

/**
 * Detect missing error handling (try-catch around risky operations).
 */
function detectMissingErrorHandling(lines) {
    const smells = [];
    const riskyPatterns = [
        { pattern: /JSON\.parse\s*\(/, label: 'JSON.parse()' },
        { pattern: /fs\.(readFileSync|writeFileSync|unlinkSync|mkdirSync)\s*\(/, label: 'synchronous fs operation' },
        { pattern: /require\s*\(\s*[^)]+\)/, label: 'require()' },
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip if line is inside a comment
        if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;

        for (const risky of riskyPatterns) {
            if (risky.pattern.test(line)) {
                // Check if it's inside a try block by looking at preceding lines
                let insideTry = false;
                let braceDepth = 0;
                for (let j = i; j >= Math.max(0, i - 20); j--) {
                    const prevLine = lines[j];
                    for (const ch of prevLine) {
                        if (ch === '}') braceDepth++;
                        if (ch === '{') braceDepth--;
                    }
                    if (/\btry\s*\{/.test(prevLine) && braceDepth <= 0) {
                        insideTry = true;
                        break;
                    }
                }
                if (!insideTry) {
                    smells.push({
                        type: 'missing-error-handling',
                        line: i + 1,
                        detail: `${risky.label} without try-catch error handling`,
                        severity: 'high',
                    });
                }
            }
        }
    }

    return smells;
}

/**
 * Detect console.log statements (should be removed or replaced with proper logging).
 */
function detectConsoleLogs(lines) {
    const smells = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments
        if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;

        if (/\bconsole\.(log|debug|info|warn|error)\s*\(/.test(line)) {
            // console.error and console.warn are less of a smell
            const isError = /console\.(warn|error)/.test(line);
            smells.push({
                type: 'console-log',
                line: i + 1,
                detail: `console statement found - consider using a proper logging framework`,
                severity: isError ? 'low' : 'medium',
            });
        }
    }
    return smells;
}

runSkill('refactoring-engine', () => {
    requireArgs(argv, ['input']);
    const inputPath = validateFilePath(argv.input, 'input');
    const content = fs.readFileSync(inputPath, 'utf8');
    const lines = content.split('\n');

    // Run all detectors
    const allSmells = [
        ...detectLongFunctions(lines),
        ...detectDeepNesting(lines),
        ...detectLongLines(lines),
        ...detectDuplicatePatterns(lines),
        ...detectMagicNumbers(lines),
        ...detectMissingErrorHandling(lines),
        ...detectConsoleLogs(lines),
    ];

    // Sort by line number
    allSmells.sort((a, b) => a.line - b.line);

    // Build severity summary
    const bySeverity = { high: 0, medium: 0, low: 0 };
    for (const smell of allSmells) {
        bySeverity[smell.severity] = (bySeverity[smell.severity] || 0) + 1;
    }

    const result = {
        file: inputPath,
        smells: allSmells,
        summary: {
            total: allSmells.length,
            bySeverity,
        },
    };

    if (argv.out) {
        safeWriteFile(argv.out, JSON.stringify(result, null, 2));
    }

    return result;
});
