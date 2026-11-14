import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';
import { DEFAULT_FRONT_DESK_PORTS } from '@agent/core/front-desk-nav';
import { COMPUTER_SURFACE_MIRROR_FALLBACK_PORT } from '@agent/core/front-desk-progress';

/**
 * RS-04 drift guard: knowledge/product/governance/surfaces/*.json is the
 * single port ledger; the front-desk fallback constants are fs-free mirrors.
 * This test fails if the manifest changes and the constants are not updated.
 */
const rootDir = process.cwd();

function manifestPort(surfaceId: string): number {
  const manifest = JSON.parse(
    safeReadFile(path.join(rootDir, `knowledge/product/governance/surfaces/${surfaceId}.json`), {
      encoding: 'utf8',
    }) as string
  );
  const surface = manifest.surfaces.find((s: { id: string }) => s.id === surfaceId);
  if (!surface) throw new Error(`surface ${surfaceId} missing from manifest`);
  if (typeof surface.port === 'number') return surface.port;
  const flagIndex = (surface.args ?? []).indexOf('--port');
  if (flagIndex >= 0) return Number(surface.args[flagIndex + 1]);
  throw new Error(`surface ${surfaceId} declares no port`);
}

describe('front-desk port defaults stay aligned with the surface manifest', () => {
  it.each([
    ['presence-studio', DEFAULT_FRONT_DESK_PORTS['presence-studio']],
    ['concierge', DEFAULT_FRONT_DESK_PORTS.concierge],
    ['computer-surface', COMPUTER_SURFACE_MIRROR_FALLBACK_PORT],
  ])('%s fallback port matches the registered manifest port', (surfaceId, fallback) => {
    expect(fallback).toBe(manifestPort(surfaceId));
  });
});
