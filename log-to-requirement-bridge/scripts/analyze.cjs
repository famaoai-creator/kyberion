#!/usr/bin/env node
/**
 * log-to-requirement-bridge: Parses log files to extract error/warning patterns
 * and generates suggested improvement requirements.
 *
 * Usage:
 *   node analyze.cjs --input <logfile>
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to the log file to analyze',
  })
  .help().argv;

// --- Pattern definitions for common log formats ---
const LOG_LEVEL_PATTERNS = [
  { regex: /\b(ERROR|FATAL|CRITICAL)\b/i, severity: 'error' },
  { regex: /\b(WARN|WARNING)\b/i, severity: 'warning' },
  { regex: /\b(INFO)\b/i, severity: 'info' },
  { regex: /\b(DEBUG|TRACE)\b/i, severity: 'debug' },
];

const ERROR_CATEGORY_PATTERNS = [
  {
    regex: /timeout|timed?\s*out/i,
    category: 'timeout',
    description: 'Request or operation timeout',
  },
  {
    regex: /connection\s*(refused|reset|closed|failed)/i,
    category: 'connection-failure',
    description: 'Network connection failure',
  },
  {
    regex: /out\s*of\s*memory|OOM|heap\s*(space|size)/i,
    category: 'memory',
    description: 'Memory exhaustion or OOM',
  },
  {
    regex:
      /null\s*pointer|undefined\s*is\s*not|cannot\s*read\s*propert(y|ies)\s*of\s*(null|undefined)/i,
    category: 'null-reference',
    description: 'Null/undefined reference error',
  },
  {
    regex: /permission\s*denied|access\s*denied|unauthorized|403\s*forbidden/i,
    category: 'auth-permission',
    description: 'Authorization or permission failure',
  },
  { regex: /not\s*found|404|ENOENT/i, category: 'not-found', description: 'Resource not found' },
  {
    regex: /disk\s*(full|space)|no\s*space\s*left/i,
    category: 'disk-space',
    description: 'Disk space exhaustion',
  },
  {
    regex: /rate\s*limit|too\s*many\s*requests|429/i,
    category: 'rate-limit',
    description: 'Rate limiting triggered',
  },
  {
    regex: /deadlock|lock\s*timeout/i,
    category: 'deadlock',
    description: 'Deadlock or lock contention',
  },
  {
    regex: /syntax\s*error|parse\s*error|unexpected\s*token/i,
    category: 'parse-error',
    description: 'Syntax or parsing error',
  },
  { regex: /SSL|TLS|certificate/i, category: 'ssl-tls', description: 'SSL/TLS certificate issue' },
  {
    regex: /database|SQL|query\s*failed|relation\s*.*does\s*not\s*exist/i,
    category: 'database',
    description: 'Database query or connection error',
  },
];

/**
 * Classify a single log line.
 * @param {string} line
 * @returns {{ severity: string, categories: string[] }}
 */
function classifyLine(line) {
  let severity = 'unknown';
  for (const pat of LOG_LEVEL_PATTERNS) {
    if (pat.regex.test(line)) {
      severity = pat.severity;
      break;
    }
  }

  const categories = [];
  for (const pat of ERROR_CATEGORY_PATTERNS) {
    if (pat.regex.test(line)) {
      categories.push(pat.category);
    }
  }

  return { severity, categories };
}

/**
 * Generate requirement suggestions from discovered patterns.
 * @param {Object[]} patterns - Array of { pattern, count, severity, description }
 * @param {number} errorCount
 * @param {number} warningCount
 * @param {number} totalLines
 * @returns {string[]}
 */
function generateRequirements(patterns, errorCount, warningCount, totalLines) {
  const requirements = [];

  // Sort patterns by count descending (most frequent first)
  const sorted = [...patterns].sort((a, b) => b.count - a.count);

  for (const p of sorted) {
    if (p.count >= 1) {
      switch (p.pattern) {
        case 'timeout':
          requirements.push(
            `REQ: Implement retry logic with exponential backoff for operations experiencing timeouts (${p.count} occurrences detected).`
          );
          requirements.push(
            `REQ: Add configurable timeout thresholds and circuit-breaker patterns for external service calls.`
          );
          break;
        case 'connection-failure':
          requirements.push(
            `REQ: Implement connection pooling and health checks for external dependencies (${p.count} connection failures detected).`
          );
          break;
        case 'memory':
          requirements.push(
            `REQ: Conduct memory profiling and implement resource limits. Add OOM-prevention safeguards (${p.count} memory issues detected).`
          );
          break;
        case 'null-reference':
          requirements.push(
            `REQ: Add defensive null checks and input validation at service boundaries (${p.count} null reference errors detected).`
          );
          break;
        case 'auth-permission':
          requirements.push(
            `REQ: Review and document permission requirements. Implement proper error messaging for auth failures (${p.count} occurrences).`
          );
          break;
        case 'not-found':
          requirements.push(
            `REQ: Validate resource existence before access and improve 404 error handling (${p.count} not-found errors detected).`
          );
          break;
        case 'disk-space':
          requirements.push(
            `REQ: Implement disk space monitoring with alerts and automated log rotation (${p.count} disk space warnings).`
          );
          break;
        case 'rate-limit':
          requirements.push(
            `REQ: Implement client-side rate limiting and request queuing to avoid upstream rate limits (${p.count} occurrences).`
          );
          break;
        case 'deadlock':
          requirements.push(
            `REQ: Review database transaction isolation levels and implement deadlock-retry logic (${p.count} deadlock events).`
          );
          break;
        case 'parse-error':
          requirements.push(
            `REQ: Add input validation and schema checking at parsing boundaries (${p.count} parse errors detected).`
          );
          break;
        case 'ssl-tls':
          requirements.push(
            `REQ: Review SSL/TLS certificate management and implement automated renewal monitoring (${p.count} SSL issues).`
          );
          break;
        case 'database':
          requirements.push(
            `REQ: Implement database connection resilience (retries, pool health) and query timeout settings (${p.count} DB errors).`
          );
          break;
        default:
          requirements.push(
            `REQ: Investigate and address recurring "${p.pattern}" issues (${p.count} occurrences).`
          );
      }
    }
  }

  // Add general requirements based on overall error/warning rates
  const errorRate = totalLines > 0 ? (errorCount / totalLines) * 100 : 0;
  if (errorRate > 10) {
    requirements.push(
      `REQ: Error rate is ${errorRate.toFixed(1)}% of total log lines. Implement structured logging and centralized error monitoring.`
    );
  }

  if (warningCount > errorCount * 2) {
    requirements.push(
      `REQ: Warning count (${warningCount}) significantly exceeds error count (${errorCount}). Review warning severity classifications.`
    );
  }

  if (requirements.length === 0) {
    requirements.push('No significant error patterns detected. Log health appears acceptable.');
  }

  return requirements;
}

runSkill('log-to-requirement-bridge', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const totalLines = lines.length;

  // Counters by severity
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let debugCount = 0;

  // Pattern frequency map: category -> { count, severity, description }
  const patternMap = {};

  for (const line of lines) {
    const { severity, categories } = classifyLine(line);

    switch (severity) {
      case 'error':
        errorCount++;
        break;
      case 'warning':
        warningCount++;
        break;
      case 'info':
        infoCount++;
        break;
      case 'debug':
        debugCount++;
        break;
    }

    for (const cat of categories) {
      if (!patternMap[cat]) {
        const def = ERROR_CATEGORY_PATTERNS.find((p) => p.category === cat);
        patternMap[cat] = {
          pattern: cat,
          count: 0,
          severity: severity,
          description: def ? def.description : cat,
        };
      }
      patternMap[cat].count++;
      // Escalate severity to the worst seen
      if (severity === 'error' && patternMap[cat].severity !== 'error') {
        patternMap[cat].severity = 'error';
      }
    }
  }

  const patterns = Object.values(patternMap).sort((a, b) => b.count - a.count);
  const suggestedRequirements = generateRequirements(
    patterns,
    errorCount,
    warningCount,
    totalLines
  );

  return {
    source: path.basename(resolved),
    totalLines,
    errorCount,
    warningCount,
    infoCount,
    debugCount,
    patterns,
    suggestedRequirements,
  };
});
