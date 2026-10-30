import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeReaddir, safeRmSync } from '@agent/core/secure-io';
import { auditChain } from '@agent/core/governance/audit-chain';
import { withExecutionContext } from '@agent/core/authority';
import {
  BROWSER_BRIDGE_MAILBOX_ROOT,
  BROWSER_BRIDGE_OBSERVE_PROCEDURE_ID,
  enqueueBrowserBridgeRequest,
  loadBrowserBridgeRequest,
} from '@agent/core/browser/browser-bridge-mailbox';

const ingestMain = vi.hoisted(() =>
  vi.fn(async (_argv: string[], print: (value: unknown) => void) => {
    print('[ingest] committed ingest:browser-bridge@v1 → knowledge/confidential/acme/ingest/x.md');
  })
);
const resolveProcedure = vi.hoisted(() =>
  vi.fn(async (intent: string) => ({ status: 'no_match', intent }))
);

vi.mock('./ingest.js', () => ({ main: ingestMain }));
vi.mock('@agent/core/knowledge/procedure-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveProcedure,
}));
vi.mock('@agent/core/organization/tenant-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTenant: vi.fn((slug: string) => {
    if (slug !== 'acme') throw new Error(`no profile for ${slug}`);
    return { profile: { tenant_slug: slug } };
  }),
}));

let handle: typeof import('./browser_bridge_host.js').handle;
/** Loose view of a host reply for assertions (fields vary per message type). */
interface Reply {
  ok: boolean;
  requests: Array<Record<string, unknown>>;
  approvals: unknown[];
  staged_ref: string;
  mode: string;
  page: Record<string, unknown>;
  ingest: { status: string; next?: string };
  [key: string]: unknown;
}
const MAILBOX = pathResolver.rootResolve(BROWSER_BRIDGE_MAILBOX_ROOT);
const staged: string[] = [];

beforeAll(async () => {
  ({ handle } = await import('./browser_bridge_host.js'));
}, 60_000);

afterEach(() => {
  safeRmSync(MAILBOX, { recursive: true, force: true });
  // Staged pages live in a tier partition; the host writes them as sovereign_concierge.
  const refs = staged.splice(0);
  asConcierge(() => {
    for (const ref of refs) {
      let dir = path.dirname(pathResolver.rootResolve(ref));
      safeRmSync(dir, { recursive: true, force: true });
      // Prune the partition directories this test created, but only while empty.
      const floor = pathResolver.rootResolve('active/shared/staging');
      for (dir = path.dirname(dir); dir.startsWith(floor + path.sep); dir = path.dirname(dir)) {
        if (!safeExistsSync(dir) || safeReaddir(dir).length > 0) break;
        safeRmSync(dir, { recursive: true, force: true });
      }
    }
  });
  ingestMain.mockClear();
  resolveProcedure.mockClear();
  vi.restoreAllMocks();
});

const asConcierge = <T>(fn: () => T): T =>
  withExecutionContext('sovereign_concierge', fn, 'sovereign');

function queueObserve() {
  return enqueueBrowserBridgeRequest({
    request_kind: 'observe_tab',
    payload: {
      purpose: 'Read the invoice list',
      mode: 'text',
      allowed_origins: ['https://example.com'],
    },
    requested_by: { actor_id: 'agent:test', mission_id: 'MSN-TEST-1' },
    scope: { tier: 'personal' },
  });
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    type: 'send_page',
    mode: 'knowledge',
    tier: 'confidential',
    tenant_slug: 'acme',
    title: 'Quarterly report',
    url_origin: 'https://example.com',
    text: 'Revenue grew. Contact finance@example.com for details.',
    selection_only: false,
    ...overrides,
  };
}

describe('poll_requests / respond_request', () => {
  it('delivers mailbox requests and accepts a bound, re-redacted observation', async () => {
    const request = queueObserve();
    const audit = vi.spyOn(auditChain, 'record');
    const polled = (await handle({ type: 'poll_requests' })) as Reply;
    expect(polled.ok).toBe(true);
    expect(Array.isArray(polled.approvals)).toBe(true);
    expect(polled.requests).toHaveLength(1);
    expect(polled.requests[0]).toMatchObject({
      request_id: request.request_id,
      request_kind: 'observe_tab',
      status: 'delivered',
    });
    expect(polled.requests[0]).not.toHaveProperty('response');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'browser_bridge_deliver' })
    );

    const answered = (await handle({
      type: 'respond_request',
      request_id: request.request_id,
      status: 'completed',
      result: {
        observation: {
          schema_version: 'browser-observation.v1',
          observation_id: 'OBS-1',
          procedure_id: BROWSER_BRIDGE_OBSERVE_PROCEDURE_ID,
          recording_id: request.request_id,
          lease_id: `LEASE-${request.request_id}`,
          origin: 'https://example.com',
          captured_at: '2026-10-31T00:01:00.000Z',
          source: 'chrome-extension',
          fields: [{ name: 'body', text: 'mail me: dave@example.com' }],
        },
      },
    })) as Reply;
    expect(answered).toEqual({ ok: true, request_id: request.request_id, status: 'completed' });
    const stored = loadBrowserBridgeRequest(request.request_id);
    expect(JSON.stringify(stored?.response)).not.toContain('dave@example.com');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'browser_bridge_respond' })
    );

    const again = (await handle({
      type: 'respond_request',
      request_id: request.request_id,
      status: 'declined',
    })) as Reply;
    expect(again).toMatchObject({ ok: false, code: 'terminal' });
  });

  it('rejects unknown requests and malformed observations', async () => {
    expect(
      await handle({
        type: 'respond_request',
        request_id: 'BBR-00000000-0000-4000-8000-000000000000',
        status: 'declined',
      })
    ).toMatchObject({ ok: false, code: 'not_found' });
    const request = queueObserve();
    expect(
      await handle({
        type: 'respond_request',
        request_id: request.request_id,
        status: 'completed',
        result: { observation: { schema_version: 'browser-observation.v1' } },
      })
    ).toMatchObject({ ok: false, code: 'invalid_response' });
  });
});

describe('send_page', () => {
  it('enforces tier/tenant rules and public confirmation', async () => {
    expect(await handle(page({ tenant_slug: undefined }))).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(await handle(page({ tenant_slug: 'shared' }))).toMatchObject({ ok: false });
    expect(await handle(page({ tenant_slug: 'other-co' }))).toMatchObject({ ok: false });
    expect(await handle(page({ tier: 'public', tenant_slug: undefined }))).toMatchObject({
      ok: false,
      error: 'public tier requires confirm_public: true',
    });
    expect(await handle(page({ url_origin: 'javascript:alert(1)' }))).toMatchObject({ ok: false });
    expect(await handle(page({ text: 'x'.repeat(30_001) }))).toMatchObject({ ok: false });
    expect(ingestMain).not.toHaveBeenCalled();
  });

  it('stages the scrubbed page and runs the governed ingest for a confidential tenant', async () => {
    const audit = vi.spyOn(auditChain, 'record');
    const result = (await handle(page())) as Reply;
    expect(result.ok).toBe(true);
    staged.push(result.staged_ref);
    expect(result.staged_ref).toMatch(
      /^active\/shared\/staging\/confidential\/acme\/browser-bridge\/.+\.md$/
    );
    expect(result.ingest.status).toBe('committed');
    const file = pathResolver.rootResolve(result.staged_ref);
    const body = asConcierge(() => {
      expect(safeExistsSync(file)).toBe(true);
      return String(safeReadFile(file, { encoding: 'utf8' }));
    });
    expect(body).toContain('[redacted-email]');
    expect(body).not.toContain('finance@example.com');
    const argv = ingestMain.mock.calls[0][0];
    expect(argv.slice(0, 2)).toEqual(['--tenant', 'acme']);
    expect(argv).toContain('--ingested-by');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'browser_bridge_send_page' })
    );
  });

  it('keeps public pages staged until a steward approves the ingest', async () => {
    const result = (await handle(
      page({ tier: 'public', tenant_slug: undefined, confirm_public: true })
    )) as Reply;
    expect(result.ok).toBe(true);
    staged.push(result.staged_ref);
    expect(result.staged_ref).toMatch(/^active\/shared\/staging\/public\/shared\/browser-bridge\//);
    expect(result.ingest.status).toBe('staged');
    expect(result.ingest.next).toContain('--steward-approval-id');
    expect(ingestMain).not.toHaveBeenCalled();
  });

  it('resolves intent mode through the existing procedure resolver', async () => {
    const result = (await handle(
      page({
        mode: 'intent',
        tier: 'personal',
        tenant_slug: undefined,
        note: 'この請求書を登録して',
      })
    )) as Reply;
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('intent');
    expect(resolveProcedure).toHaveBeenCalledWith('この請求書を登録して', {
      origin: 'https://example.com',
      substrate: undefined,
    });
    expect(result.page).toMatchObject({ url_origin: 'https://example.com', selection_only: false });
  });
});
