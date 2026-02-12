#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
/**
 * performance-monitor-analyst: Analyzes performance metrics from profiling
 * outputs. Compares against configurable thresholds, identifies bottlenecks,
 * calculates percentiles, and generates a performance grade.
 *
 * Usage:
 *   node analyze.cjs --input <performance-data.json>
 *
 * Input format:
 *   {
 *     "metrics": [
 *       { "name": "api/users", "value": 150, "unit": "ms", "timestamp": "..." },
 *       { "name": "memory-heap", "value": 256, "unit": "MB" },
 *       { "name": "cpu-main", "value": 45, "unit": "percent" }
 *     ],
 *     "thresholds": {
 *       "responseTime": 200,
 *       "memoryMB": 512,
 *       "cpuPercent": 80
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to a JSON file containing performance metrics',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help()
  .argv;

const DEFAULT_THRESHOLDS = {
  responseTime: 200,   // milliseconds
  memoryMB: 512,       // megabytes
  cpuPercent: 80,      // percent
  throughput: 100,     // requests per second (minimum)
  errorRate: 5,        // percent (maximum)
};

/**
 * Classify a metric into a category based on its unit or name.
 * @param {Object} metric
 * @returns {string}
 */
function classifyMetric(metric) {
  const unit = (metric.unit || '').toLowerCase();
  const name = (metric.name || '').toLowerCase();

  if (unit === 'ms' || unit === 'milliseconds' || name.includes('response') || name.includes('latency') || name.includes('duration')) {
    return 'responseTime';
  }
  if (unit === 'mb' || unit === 'megabytes' || name.includes('memory') || name.includes('heap') || name.includes('rss')) {
    return 'memory';
  }
  if (unit === 'percent' || unit === '%') {
    if (name.includes('cpu') || name.includes('processor')) {
      return 'cpu';
    }
    if (name.includes('error')) {
      return 'errorRate';
    }
    return 'cpu'; // Default percent to CPU
  }
  if (unit === 'rps' || unit === 'req/s' || name.includes('throughput') || name.includes('requests')) {
    return 'throughput';
  }
  return 'other';
}

/**
 * Calculate the Nth percentile of a sorted array.
 * @param {number[]} sorted
 * @param {number} percentile - 0 to 100
 * @returns {number}
 */
function calculatePercentile(sorted, percentile) {
  if (sorted.length === 0) return 0;
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Check a metric value against a threshold and return a violation if exceeded.
 * @param {Object} metric
 * @param {string} category
 * @param {Object} thresholds
 * @returns {Object | null}
 */
function checkThreshold(metric, category, thresholds) {
  const value = metric.value;
  let threshold = null;
  let exceeded = false;

  if (category === 'responseTime' && thresholds.responseTime !== undefined) {
    threshold = thresholds.responseTime;
    exceeded = value > threshold;
  } else if (category === 'memory' && thresholds.memoryMB !== undefined) {
    threshold = thresholds.memoryMB;
    exceeded = value > threshold;
  } else if (category === 'cpu' && thresholds.cpuPercent !== undefined) {
    threshold = thresholds.cpuPercent;
    exceeded = value > threshold;
  } else if (category === 'throughput' && thresholds.throughput !== undefined) {
    threshold = thresholds.throughput;
    exceeded = value < threshold; // Throughput: lower is worse
  } else if (category === 'errorRate' && thresholds.errorRate !== undefined) {
    threshold = thresholds.errorRate;
    exceeded = value > threshold;
  }

  if (exceeded) {
    return {
      metric: metric.name,
      category,
      value,
      threshold,
      severity: calculateSeverity(value, threshold, category),
    };
  }

  return null;
}

/**
 * Determine severity of a threshold violation.
 * @param {number} value
 * @param {number} threshold
 * @param {string} category
 * @returns {string}
 */
function calculateSeverity(value, threshold, category) {
  let ratio;
  if (category === 'throughput') {
    // For throughput, lower is worse
    ratio = threshold / Math.max(value, 1);
  } else {
    ratio = value / Math.max(threshold, 1);
  }

  if (ratio >= 2.0) return 'critical';
  if (ratio >= 1.5) return 'high';
  if (ratio >= 1.2) return 'medium';
  return 'low';
}

/**
 * Identify bottlenecks from metrics.
 * @param {Object} categorized
 * @param {Object} thresholds
 * @returns {Object[]}
 */
function identifyBottlenecks(categorized, thresholds) {
  const bottlenecks = [];

  // Response time bottlenecks
  if (categorized.responseTime.length > 0) {
    const sorted = categorized.responseTime.map((m) => m.value).sort((a, b) => a - b);
    const p95 = calculatePercentile(sorted, 95);
    const p99 = calculatePercentile(sorted, 99);

    if (p95 > (thresholds.responseTime || DEFAULT_THRESHOLDS.responseTime)) {
      bottlenecks.push({
        type: 'responseTime',
        description: `P95 response time (${Math.round(p95)}ms) exceeds threshold (${thresholds.responseTime || DEFAULT_THRESHOLDS.responseTime}ms)`,
        severity: 'high',
        p95: Math.round(p95),
        p99: Math.round(p99),
      });
    }
  }

  // Memory bottlenecks
  if (categorized.memory.length > 0) {
    const maxMem = Math.max(...categorized.memory.map((m) => m.value));
    const memThreshold = thresholds.memoryMB || DEFAULT_THRESHOLDS.memoryMB;
    if (maxMem > memThreshold * 0.9) {
      bottlenecks.push({
        type: 'memory',
        description: `Peak memory (${Math.round(maxMem)}MB) is at ${Math.round((maxMem / memThreshold) * 100)}% of threshold (${memThreshold}MB)`,
        severity: maxMem > memThreshold ? 'critical' : 'warning',
        peakMB: Math.round(maxMem),
      });
    }
  }

  // CPU bottlenecks
  if (categorized.cpu.length > 0) {
    const avgCpu = categorized.cpu.reduce((sum, m) => sum + m.value, 0) / categorized.cpu.length;
    const cpuThreshold = thresholds.cpuPercent || DEFAULT_THRESHOLDS.cpuPercent;
    if (avgCpu > cpuThreshold * 0.8) {
      bottlenecks.push({
        type: 'cpu',
        description: `Average CPU (${Math.round(avgCpu)}%) is at ${Math.round((avgCpu / cpuThreshold) * 100)}% of threshold (${cpuThreshold}%)`,
        severity: avgCpu > cpuThreshold ? 'critical' : 'warning',
        avgPercent: Math.round(avgCpu),
      });
    }
  }

  return bottlenecks;
}

/**
 * Calculate a performance grade based on score.
 * @param {number} score - 0 to 100
 * @returns {string}
 */
function scoreToGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Generate recommendations based on analysis.
 * @param {Object[]} violations
 * @param {Object[]} bottlenecks
 * @param {Object} summary
 * @returns {string[]}
 */
function generateRecommendations(violations, bottlenecks, summary) {
  const recommendations = [];

  const criticalViolations = violations.filter((v) => v.severity === 'critical');
  if (criticalViolations.length > 0) {
    recommendations.push(
      `${criticalViolations.length} critical violation(s) detected. Immediate investigation required for: ${criticalViolations.map((v) => v.metric).join(', ')}.`
    );
  }

  if (summary.avgResponseTime > 500) {
    recommendations.push(
      'Average response time exceeds 500ms. Consider implementing caching, query optimization, or load balancing.'
    );
  } else if (summary.avgResponseTime > 200) {
    recommendations.push(
      'Average response time is above 200ms. Review slow endpoints and consider adding database indexes or response compression.'
    );
  }

  if (summary.maxMemory > 400) {
    recommendations.push(
      `Peak memory usage is ${Math.round(summary.maxMemory)}MB. Review for memory leaks, large object allocations, or unbounded caches.`
    );
  }

  if (summary.avgCpu > 70) {
    recommendations.push(
      `Average CPU usage is ${Math.round(summary.avgCpu)}%. Consider horizontal scaling, offloading computation to worker threads, or optimizing hot paths.`
    );
  }

  const memoryBottleneck = bottlenecks.find((b) => b.type === 'memory');
  const cpuBottleneck = bottlenecks.find((b) => b.type === 'cpu');
  if (memoryBottleneck && cpuBottleneck) {
    recommendations.push(
      'Both memory and CPU are under pressure. This may indicate the application needs to be scaled vertically or horizontally.'
    );
  }

  if (recommendations.length === 0) {
    recommendations.push('Performance metrics are within acceptable thresholds. No immediate action required.');
  }

  return recommendations;
}

runSkill('performance-monitor-analyst', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (_err) {
    throw new Error(`Failed to parse JSON: ${err.message}`);
  }

  if (!data || !Array.isArray(data.metrics) || data.metrics.length === 0) {
    throw new Error('Input must contain a "metrics" array with at least one metric entry.');
  }

  // Merge user thresholds with defaults
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(data.thresholds || {}) };

  // Categorize metrics
  const categorized = {
    responseTime: [],
    memory: [],
    cpu: [],
    throughput: [],
    errorRate: [],
    other: [],
  };

  const violations = [];

  for (const metric of data.metrics) {
    if (typeof metric.value !== 'number') continue;

    const category = classifyMetric(metric);
    if (categorized[category]) {
      categorized[category].push(metric);
    } else {
      categorized.other.push(metric);
    }

    const violation = checkThreshold(metric, category, thresholds);
    if (violation) {
      violations.push(violation);
    }
  }

  // Calculate summary statistics
  const rtValues = categorized.responseTime.map((m) => m.value);
  const memValues = categorized.memory.map((m) => m.value);
  const cpuValues = categorized.cpu.map((m) => m.value);

  const summary = {
    avgResponseTime: rtValues.length > 0
      ? Math.round(rtValues.reduce((a, b) => a + b, 0) / rtValues.length * 100) / 100
      : 0,
    maxResponseTime: rtValues.length > 0 ? Math.max(...rtValues) : 0,
    p95ResponseTime: rtValues.length > 0
      ? Math.round(calculatePercentile(rtValues.slice().sort((a, b) => a - b), 95) * 100) / 100
      : 0,
    p99ResponseTime: rtValues.length > 0
      ? Math.round(calculatePercentile(rtValues.slice().sort((a, b) => a - b), 99) * 100) / 100
      : 0,
    maxMemory: memValues.length > 0 ? Math.max(...memValues) : 0,
    avgMemory: memValues.length > 0
      ? Math.round(memValues.reduce((a, b) => a + b, 0) / memValues.length * 100) / 100
      : 0,
    avgCpu: cpuValues.length > 0
      ? Math.round(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length * 100) / 100
      : 0,
    maxCpu: cpuValues.length > 0 ? Math.max(...cpuValues) : 0,
  };

  // Identify bottlenecks
  const bottlenecks = identifyBottlenecks(categorized, thresholds);

  // Calculate score (start at 100, deduct for violations and bottlenecks)
  let score = 100;
  for (const violation of violations) {
    if (violation.severity === 'critical') score -= 20;
    else if (violation.severity === 'high') score -= 12;
    else if (violation.severity === 'medium') score -= 7;
    else score -= 3;
  }
  for (const bottleneck of bottlenecks) {
    if (bottleneck.severity === 'critical') score -= 10;
    else score -= 5;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const grade = scoreToGrade(score);
  const recommendations = generateRecommendations(violations, bottlenecks, summary);

  const report = {
    grade,
    score,
    totalMetrics: data.metrics.length,
    violations,
    bottlenecks,
    summary,
    thresholdsUsed: thresholds,
    recommendations,
  };

  if (argv.out) {
    safeWriteFile(argv.out, JSON.stringify(report, null, 2));
  }

  return report;
});
