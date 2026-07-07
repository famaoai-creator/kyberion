import { NextResponse } from 'next/server';
import * as path from 'node:path';
import {
  getInstalledReasoningMode,
  pathResolver,
  safeReadFile,
} from '@agent/core';

export const dynamic = 'force-dynamic';

export function GET() {
  try {
    const root = pathResolver.rootDir();
    const roles = JSON.parse(
      safeReadFile(path.join(root, 'knowledge/product/governance/surface-roles.json'), {
        encoding: 'utf8',
      }) as string
    ) as { roles: Array<Record<string, unknown>> };
    const surfaces = JSON.parse(
      safeReadFile(path.join(root, 'knowledge/product/governance/active-surfaces.json'), {
        encoding: 'utf8',
      }) as string
    ) as { surfaces: Array<Record<string, unknown>> };
    let reasoning = 'unknown';
    try {
      reasoning = String(getInstalledReasoningMode() || 'not-installed');
    } catch {
      reasoning = 'not-installed';
    }
    return NextResponse.json({
      ok: true,
      setup: {
        surface_roles: roles.roles,
        active_surfaces: surfaces.surfaces.map((entry) => ({
          id: entry.id,
          port: entry.port,
          enabled: entry.enabled !== false,
        })),
        reasoning_mode: reasoning,
        model_tiers: { fast: 'haiku', standard: 'sonnet', deep: 'opus' },
        commands: {
          onboarding: 'pnpm install && pnpm build && pnpm surfaces:reconcile && pnpm onboard',
          surfaces: 'pnpm surfaces:status / pnpm surfaces:reconcile',
          reasoning: 'pnpm reasoning:setup(claude-cli 推奨)',
          company: 'pnpm company:bootstrap --list',
          minutes: 'pnpm minutes:record --mission <ID>',
        },
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
