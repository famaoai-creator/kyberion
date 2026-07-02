import { describe, expect, it } from 'vitest';
import {
  buildSurfaceLauncherRecommendations,
  getSurfaceDirectory,
  getSurfaceDirectorySummary,
  getSurfaceScenarioGuide,
} from '../src/lib/data.js';

describe('operator surface directory', () => {
  it('exposes canonical managed surfaces with auth and scenario metadata', () => {
    const rows = getSurfaceDirectory();
    expect(rows.length).toBeGreaterThan(0);

    const slack = rows.find((row) => row.id === 'slack-bridge');
    expect(slack).toBeDefined();
    expect(slack?.auth_requirement).toBe('required');
    expect(slack?.auth_strategy).toBe('bearer');
    expect(slack?.required_secrets).toContain('SLACK_ACCESS_TOKEN');
    expect(slack?.use_cases).toContain('messaging-ingress');
    expect(slack?.next_command).toMatch(/^pnpm surfaces:/);
    expect(slack?.best_for).toContain('threaded remote requests');
    expect(Array.isArray(slack?.blocked_by)).toBe(true);

    const chronos = rows.find((row) => row.id === 'chronos-mirror-v2');
    expect(chronos).toBeDefined();
    expect(chronos?.auth_requirement).toBe('host-managed');
    expect(chronos?.use_cases).toContain('operator-control');
    expect(chronos?.best_for).toContain('durable work');

    const oauth = rows.find((row) => row.id === 'oauth-callback-surface');
    expect(oauth).toBeDefined();
    expect(oauth?.use_cases).toContain('oauth-bootstrap');
  });

  it('summarizes the directory without losing auth-required counts', () => {
    const rows = getSurfaceDirectory();
    const summary = getSurfaceDirectorySummary();

    expect(summary.total).toBe(rows.length);
    expect(summary.enabled).toBeLessThanOrEqual(summary.total);
    expect(summary.auth_required).toBeGreaterThan(0);
    expect(summary.running + summary.stale).toBeLessThanOrEqual(summary.total);
    expect(summary.blocked).toBeLessThanOrEqual(summary.total);
  });

  it('publishes scenario guides for missing-UX hotspots from the audit', () => {
    const scenarios = getSurfaceScenarioGuide();
    const ids = scenarios.map((entry) => entry.id);
    expect(ids).toContain('voice-first-win');
    expect(ids).toContain('messaging-ingress');
    expect(ids).toContain('customer-engagement');
  });

  it('shares launcher recommendations with other operator surfaces', () => {
    const recommendations = buildSurfaceLauncherRecommendations();
    expect(recommendations).toHaveLength(3);
    expect(recommendations.map((entry) => entry.id)).toEqual(['chronos', 'voice-first-win', 'messaging']);
    expect(recommendations[0]?.suggestedCommand).toMatch(/^pnpm /);
  });
});
