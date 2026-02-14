#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to telemetry data (JSON)',
  })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function analyzeTelemetry(data) {
  const events = data.events || data;
  if (!Array.isArray(events)) return { eventCount: 0, features: {}, patterns: [] };

  const features = {};
  const errors = [];
  const timings = [];

  for (const event of events) {
    const feature = event.feature || event.action || event.name || 'unknown';
    if (!features[feature])
      features[feature] = { count: 0, errors: 0, avgDuration: 0, durations: [] };
    features[feature].count++;
    if (event.error || event.status === 'error') {
      features[feature].errors++;
      errors.push({ feature, error: event.error || 'unknown', timestamp: event.timestamp });
    }
    if (event.duration) {
      features[feature].durations.push(event.duration);
      timings.push({ feature, duration: event.duration });
    }
  }

  for (const [_key, f] of Object.entries(features)) {
    if (f.durations.length > 0)
      f.avgDuration = Math.round(f.durations.reduce((s, d) => s + d, 0) / f.durations.length);
    delete f.durations;
  }

  return {
    eventCount: events.length,
    features,
    errors: errors.slice(0, 20),
    timings: timings.slice(0, 20),
  };
}

function identifyGaps(telemetry) {
  const gaps = [];
  for (const [feature, data] of Object.entries(telemetry.features)) {
    if (data.errors / data.count > 0.1)
      gaps.push({
        feature,
        issue: 'High error rate',
        errorRate: Math.round((data.errors / data.count) * 100),
        priority: 'high',
      });
    if (data.avgDuration > 5000)
      gaps.push({
        feature,
        issue: 'Slow performance',
        avgDurationMs: data.avgDuration,
        priority: 'medium',
      });
    if (data.count <= 1)
      gaps.push({
        feature,
        issue: 'Low usage - consider removing or promoting',
        usage: data.count,
        priority: 'low',
      });
  }
  return gaps.sort((a, b) => {
    const p = { high: 0, medium: 1, low: 2 };
    return (p[a.priority] || 3) - (p[b.priority] || 3);
  });
}

function generateInsights(telemetry, gaps) {
  const topFeatures = Object.entries(telemetry.features)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([name, data]) => ({ name, ...data }));
  return {
    topFeatures,
    underperforming: gaps.filter((g) => g.priority === 'high'),
    unusedFeatures: gaps.filter((g) => g.issue.includes('Low usage')),
    totalErrors: telemetry.errors.length,
  };
}

runSkill('telemetry-insight-engine', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const telemetry = analyzeTelemetry(data);
  const gaps = identifyGaps(telemetry);
  const insights = generateInsights(telemetry, gaps);
  const result = {
    source: path.basename(resolved),
    eventCount: telemetry.eventCount,
    featureCount: Object.keys(telemetry.features).length,
    insights,
    gaps,
    recommendations: gaps.slice(0, 5).map((g) => `[${g.priority}] ${g.feature}: ${g.issue}`),
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
