import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';
import { loadSurfaceManifest } from '@agent/core/surface/surface-runtime';
import { resolveSurfacePort, resolveSurfaceUrl } from '@agent/core/surface/surface-url';
import { getSurfaceDirectory } from '@agent/core/surface/surface-ux';
import {
  getControlPlaneBaseUrl,
  getControlPlaneRemediationPlan,
} from '@agent/core/control-plane-client';

const root = process.cwd();
const readJson = (rel: string) =>
  JSON.parse(safeReadFile(path.join(root, rel), { encoding: 'utf8' }) as string);

describe('RS-04 surface registry consistency', () => {
  const manifest = loadSurfaceManifest();
  const snapshot = readJson('knowledge/product/governance/active-surfaces.json');
  const roles = readJson('knowledge/product/governance/surface-roles.json').roles as Array<{
    id: string;
    port: number;
    enabled?: boolean;
  }>;

  it('keeps active-surfaces.json identical to the canonical per-surface manifests', () => {
    expect(snapshot.surfaces).toEqual(manifest.surfaces);
  });

  it('registers every surface-roles entry with the same port', () => {
    for (const role of roles) {
      const def = manifest.surfaces.find((s) => s.id === role.id);
      expect(def, `${role.id} missing from the surface registry`).toBeDefined();
      expect(def?.port, `${role.id} port`).toBe(role.port);
    }
  });

  it('has no duplicate ports and keeps legacy pad ports free', () => {
    const ports = manifest.surfaces.flatMap((s) => (typeof s.port === 'number' ? [s.port] : []));
    expect(new Set(ports).size).toBe(ports.length);
    for (const legacy of [8137, 8147, 8148, 8149, 8150, 8151, 8152, 8153, 8154]) {
      expect(ports).not.toContain(legacy);
    }
    expect(resolveSurfacePort('personal-pads')).toBe(8160);
    expect(resolveSurfacePort('operator-surface')).toBe(3331);
  });

  it('does not auto-start credential-dependent, macOS-only or operator-launched surfaces', () => {
    for (const id of [
      'slack-bridge',
      'telegram-bridge',
      'imessage-bridge',
      'discord-bridge',
      'operator-surface',
      'personal-pads',
      'terminal-hud',
    ]) {
      expect(manifest.surfaces.find((s) => s.id === id)?.enabled, id).toBe(false);
    }
  });

  it('resolves surface URLs from the registry and honours the declared env override', () => {
    expect(resolveSurfaceUrl('presence-studio')).toBe('http://127.0.0.1:3031');
    expect(resolveSurfaceUrl('computer-surface')).toBe('http://127.0.0.1:3040');
    expect(resolveSurfaceUrl('telegram-bridge')).toBe('http://127.0.0.1:3035');
    expect(() => resolveSurfaceUrl('no-such-surface')).toThrow(/SURFACE_REGISTRY/);
    const prev = process.env.PRESENCE_STUDIO_URL;
    process.env.PRESENCE_STUDIO_URL = 'http://127.0.0.1:4999/';
    try {
      expect(resolveSurfaceUrl('presence-studio')).toBe('http://127.0.0.1:4999');
    } finally {
      if (prev === undefined) delete process.env.PRESENCE_STUDIO_URL;
      else process.env.PRESENCE_STUDIO_URL = prev;
    }
  });

  it('derives control-plane URLs and remediation plans from the registry', () => {
    expect(getControlPlaneBaseUrl('chronos')).toBe('http://127.0.0.1:3000');
    expect(getControlPlaneRemediationPlan('presence')).toEqual({
      surface: 'presence',
      runtimeId: 'presence-studio',
      suggestedCommand: 'pnpm surfaces reconcile',
    });
  });

  it('derives operator notes from registry vocabulary keys', () => {
    const rows = getSurfaceDirectory();
    const slack = rows.find((r) => r.id === 'slack-bridge');
    expect(slack?.operator_notes).toContain('External channel ingress');
    expect(slack?.best_for).toBe('threaded remote requests and follow-up');
    expect(rows.find((r) => r.id === 'nexus-daemon')?.best_for).toBe('managed runtime access');
  });
});
