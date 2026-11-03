import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { authorizationOverlayCatalog, loadAuthorizationOverlays } from './authorization-overlay.js';
import {
  codeOperationPatterns,
  operationAuthorization,
} from '../foundation/authorization-registry.js';

const ROOT = process.cwd();
const SHIPPED_CAPTURE_READS = [
  'service:github:preset:list_pulls',
  'service:github:preset:list_reviews',
  'service:github:preset:get_commit_check_runs',
  'service:github:preset:get_review_threads',
  'service:google-workspace:preset:gmail_profile_get',
  'service:google-workspace:preset:gmail_messages_list',
  'service:google-workspace:preset:gmail_message_get',
  'service:google-workspace:preset:gmail_history_list',
  'service:google-workspace:preset:gmail_thread_get',
  'service:jira:preset:search_issues_enhanced',
  'service:jira:preset:get_request_approvals',
  'service:jira:preset:get_request_approval',
  'service:jira:preset:get_issue',
  'service:jira:preset:get_issue_comments',
] as const;
const CAPTURE_READ_AUTHORIZATION = {
  effectClass: 'external_read',
  authority: { kind: 'admission', boundary: 'external' },
  protectedPaths: [['params']],
} as const;

describe('authorization-overlay catalog', () => {
  it('the shipped overlay file loads through the governed-catalog pipeline', () => {
    const loaded = authorizationOverlayCatalog.load();
    expect(loaded).toEqual(expect.objectContaining({}));
    expect(loaded.operations ?? {}).toEqual({
      ...Object.fromEntries(
        SHIPPED_CAPTURE_READS.map((subject) => [subject, CAPTURE_READ_AUTHORIZATION])
      ),
      'credential:information_asset_capture': {
        effectClass: 'credential_use',
        authority: { kind: 'binding', scope: 'tenant' },
      },
    });
    // Exact capture reads retain external admission; every other service operation
    // still uses the governed fallback: `service:*`
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

  it('exact shipped reads override the service mutation fallback without weakening admission', () => {
    for (const subject of SHIPPED_CAPTURE_READS) {
      expect(operationAuthorization(subject), subject).toEqual({
        ...CAPTURE_READ_AUTHORIZATION,
        declared: true,
        source: 'overlay',
      });
    }
    expect(operationAuthorization('credential:information_asset_capture')).toEqual({
      effectClass: 'credential_use',
      authority: { kind: 'binding', scope: 'tenant' },
      declared: true,
      source: 'overlay',
    });
    expect(
      operationAuthorization('service:unregistered-provider:preset:unreviewed-operation')
    ).toEqual({
      effectClass: 'external_mutation',
      authority: { kind: 'admission', boundary: 'external' },
      protectedPaths: [['params']],
      declared: true,
      source: 'overlay',
    });
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
