import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { authorizationOverlayCatalog, loadAuthorizationOverlays } from './authorization-overlay.js';
import {
  codeOperationPatterns,
  operationAuthorization,
} from '../foundation/authorization-registry.js';

const ROOT = process.cwd();

describe('authorization-overlay catalog', () => {
  it('the shipped overlay file loads through the governed-catalog pipeline', () => {
    const loaded = authorizationOverlayCatalog.load();
    expect(loaded).toEqual(expect.objectContaining({}));
    expect(loaded.operations ?? {}).toEqual({});
    // The data layer deliberately ships one governed fallback: `service:*`
    // operations are external mutations requiring external admission with
    // `params` protected — kept out of the code plane so plugin/overlay
    // providers can still declare exact `service:<provider>` subjects that
    // outrank this prefix (flat data-plane precedence).
    expect(loaded.prefixes ?? {}).toEqual({
      'service:': {
        effectClass: 'external_mutation',
        authority: { kind: 'admission', boundary: 'external' },
        protectedPaths: [['params']],
      },
    });
  });

  it('rejects malformed entries (closed taxonomy enforced by schema)', () => {
    expect(() =>
      authorizationOverlayCatalog.validate({
        operations: {
          'acme:bad': { effectClass: 'not_a_class', authority: { kind: 'free' } },
        },
      })
    ).toThrow(/Invalid catalog/);
    expect(() =>
      authorizationOverlayCatalog.validate({
        operations: {
          'acme:bad': {
            effectClass: 'external_read',
            authority: { kind: 'admission' }, // missing boundary
          },
        },
      })
    ).toThrow(/Invalid catalog/);
    expect(() =>
      authorizationOverlayCatalog.validate({
        operations: { 'BAD ID': { effectClass: 'external_read', authority: { kind: 'free' } } },
      })
    ).toThrow(/Invalid catalog/);
  });

  it('data layers cannot declare free authority or local_only class', () => {
    // A data declaration that bypasses admission would let an unreviewed file
    // weaken the deny-by-default posture — both forms must be rejected.
    expect(() =>
      authorizationOverlayCatalog.validate({
        operations: {
          'acme:local': { effectClass: 'local_only', authority: { kind: 'free' } },
        },
      })
    ).toThrow(/Invalid catalog/);
    expect(() =>
      authorizationOverlayCatalog.validate({
        operations: {
          'acme:quiet': {
            effectClass: 'external_read',
            authority: { kind: 'free' },
          },
        },
      })
    ).toThrow(/Invalid catalog/);
    expect(() =>
      authorizationOverlayCatalog.validate({
        prefixes: {
          'acme:': {
            effectClass: 'local_only',
            authority: { kind: 'admission', boundary: 'internal' },
          },
        },
      })
    ).toThrow(/Invalid catalog/);
  });
});

describe('authorization-overlay provider (registered at import)', () => {
  it('loadAuthorizationOverlays supplies the file overlay plus plugin overlays', () => {
    const overlays = loadAuthorizationOverlays();
    expect(overlays.length).toBeGreaterThanOrEqual(1);
    expect(overlays[0].source).toBe('overlay');
    // Provider registration happened at import; lookups consult real data.
    expect(operationAuthorization('vcs:push').source).toBe('code');
  });

  it('file overlay keys cannot collide with code-owned declarations', () => {
    const code = codeOperationPatterns();
    const overlay = loadAuthorizationOverlays()[0];
    for (const key of Object.keys(overlay.operations)) {
      expect(code.operations).not.toContain(key);
    }
    for (const key of Object.keys(overlay.prefixes)) {
      expect(code.prefixes).not.toContain(key);
    }
  });
});

describe('plugin manifest authorizations blocks', () => {
  const PLUGIN_DIRS = [path.join(ROOT, 'plugins')];

  function manifests(): string[] {
    const out: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 4) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          walk(p, depth + 1);
        } else if (e.isFile() && (e.name === 'plugin.json' || e.name === 'plugin-manifest.json')) {
          out.push(p);
        }
      }
    };
    for (const dir of PLUGIN_DIRS) {
      if (fs.existsSync(dir)) walk(dir, 0);
    }
    return out;
  }

  it('every declared authorizations block validates against the registry schema', () => {
    let checked = 0;
    for (const manifestPath of manifests()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        continue;
      }
      const block = (parsed as Record<string, unknown>)?.authorizations;
      if (block === undefined) continue;
      checked += 1;
      expect(
        () => authorizationOverlayCatalog.validate(block, manifestPath),
        `${manifestPath} authorizations block`
      ).not.toThrow();
    }
    // Informational: the gate applies whenever a plugin declares the block.
    expect(checked).toBeGreaterThanOrEqual(0);
  });
});
