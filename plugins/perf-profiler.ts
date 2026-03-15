import { safeWriteFile, safeReadFile, safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import * as path from 'node:path';

/**
 * Plugin: Performance Profiler
 */

const PROFILE_FILE = path.join(process.cwd(), 'work', 'perf-profile.json');
const WINDOW_SIZE = 20;
const REGRESSION_THRESHOLD = 2.0;

let profiles: Record<string, { times: number[]; avg: number }> = {};

try {
  if (safeExistsSync(PROFILE_FILE)) {
    const content = safeReadFile(PROFILE_FILE, { encoding: 'utf8' }) as string;
    if (content) {
      profiles = JSON.parse(content);
    }
  }
} catch (_e) {
  profiles = {};
}

export const afterSkill = (skillName: string, output: any) => {
  const duration = output.metadata ? output.metadata.duration_ms : 0;
  if (duration === 0) return;

  if (!profiles[skillName]) {
    profiles[skillName] = { times: [], avg: 0 };
  }

  const profile = profiles[skillName];

  if (profile.times.length >= 3 && profile.avg > 0) {
    const ratio = duration / profile.avg;
    if (ratio > REGRESSION_THRESHOLD) {
      console.error(
        `[PerfProfiler] ⚠️  ${skillName} regression: ${duration}ms vs avg ${Math.round(profile.avg)}ms (${ratio.toFixed(1)}x slower)`
      );
    }
  }

  profile.times.push(duration);
  if (profile.times.length > WINDOW_SIZE) {
    profile.times.shift();
  }
  profile.avg = profile.times.reduce((a, b) => a + b, 0) / profile.times.length;

  try {
    const dir = path.dirname(PROFILE_FILE);
    if (!safeExistsSync(dir)) {
      safeMkdir(dir, { recursive: true });
    }
    safeWriteFile(PROFILE_FILE, JSON.stringify(profiles, null, 2));
  } catch (_e) {
    // Silent fail
  }
};
