/**
 * Plugin: Performance Profiler
 *
 * Tracks execution performance across skill invocations and detects regressions.
 * Maintains a rolling window of execution times per skill and warns when
 * the current execution is significantly slower than the historical average.
 *
 * Data is stored in work/perf-profile.json
 */
const fs = require('fs');
const path = require('path');

const PROFILE_FILE = path.join(process.cwd(), 'work', 'perf-profile.json');
const WINDOW_SIZE = 20; // Rolling window of last N executions
const REGRESSION_THRESHOLD = 2.0; // Warn if current > 2x average

let profiles = {};

// Load existing profiles
try {
  if (fs.existsSync(PROFILE_FILE)) {
    profiles = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
  }
} catch (_e) {
  profiles = {};
}

module.exports = {
  afterSkill(skillName, output) {
    const duration = output.metadata ? output.metadata.duration_ms : 0;
    if (duration === 0) return;

    if (!profiles[skillName]) {
      profiles[skillName] = { times: [], avg: 0 };
    }

    const profile = profiles[skillName];

    // Check for regression against historical average
    if (profile.times.length >= 3 && profile.avg > 0) {
      const ratio = duration / profile.avg;
      if (ratio > REGRESSION_THRESHOLD) {
        console.error(
          `[PerfProfiler] ⚠️  ${skillName} regression: ${duration}ms vs avg ${Math.round(profile.avg)}ms (${ratio.toFixed(1)}x slower)`
        );
      }
    }

    // Update rolling window
    profile.times.push(duration);
    if (profile.times.length > WINDOW_SIZE) {
      profile.times.shift();
    }
    profile.avg = profile.times.reduce((a, b) => a + b, 0) / profile.times.length;

    // Persist
    try {
      fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
      fs.writeFileSync(PROFILE_FILE, JSON.stringify(profiles, null, 2));
    } catch (_e) {
      // Silent — profiler should never break execution
    }
  },
};
