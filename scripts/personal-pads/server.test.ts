import { describe, expect, it } from 'vitest';
import { createLocalPadContext } from '../lib/local-artifact-pad.js';
import type { AddressInfo } from 'node:net';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { PERSONAL_PADS_CLIENT_MODULES } from './client-runtime.js';
import {
  augmentPersonalPadsPage,
  createPersonalPadsServer,
  personalPadsPage,
  runPersonalPadsServer,
  PERSONAL_PADS_DEFAULT_PORT,
  toPublicPadRecord,
  toPublicRequestError,
} from './server.js';
import { PERSONAL_PADS_SURFACE } from './surface.js';

describe('unified personal pads server', () => {
  it('validates startup without binding and exposes all pad metadata', async () => {
    const output: unknown[] = [];
    const result = await runPersonalPadsServer(['--dry-run', '--tier', 'public'], {
      dryRun: true,
      print: (value) => output.push(value),
    });
    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: PERSONAL_PADS_DEFAULT_PORT,
      listening: false,
    });
    expect(output).toHaveLength(1);
  });

  it('renders the menu, scope context, and token-bound shell on the shared kit', () => {
    const context = createLocalPadContext({
      serviceId: 'personal-pads',
      sessionPrefix: 'test',
      artifact_ref: 'local-pads',
      viewer_principal: 'human:alice',
      tier: 'public',
    });
    const page = personalPadsPage('test-token', context, undefined, 'ja');
    expect(page).toContain('<html lang="ja">');
    expect(page).toContain('Capture desk');
    expect(page).toContain('memory-capture');
    expect(page).toContain('"token":"test-token"');
    expect(page).toContain('Meeting notepad');
    expect(page).toContain('drawing_data');
    expect(page).toContain('href="/kyberion-ui.css"');
    expect(page).toContain('data-pad-display-controls');
    expect(page).toContain("import { startPersonalPads } from '/personal-pads/app.js'");
    for (const hook of ['nav', 'scope', 'tier', 'fields', 'actions', 'save', 'history', 'dialog'])
      expect(page).toContain(`data-pp-${hook}`);
    expect(page).toContain('履歴');
    expect(page).toContain('"personal_pads:dialog_unsaved_message":"未保存の内容があります');
    expect(page).not.toContain('window.prompt');
    expect(augmentPersonalPadsPage(page)).toBe(page);
  });

  it('renders an English page with no Japanese UI text (PA-07)', () => {
    const context = createLocalPadContext({
      serviceId: 'personal-pads',
      sessionPrefix: 'test-en',
      artifact_ref: 'local-pads',
      viewer_principal: 'human:alice',
      tier: 'public',
    });
    const page = personalPadsPage('test-token', context, undefined, 'en');
    expect(page).toContain('<html lang="en">');
    expect(page).toContain('Capture from one place and review it safely later');
    expect(page).toContain('"personal_pads:dialog_discard":"Discard"');
    // The language switcher's endonym and the `ja` option value of the meeting
    // language select are the only non-English strings allowed on the page.
    const withoutEndonyms = page.split('日本語').join('');
    expect(withoutEndonyms).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/u);
  });

  it('keeps the browser runtime free of hardcoded prompts and literal UI text', () => {
    for (const source of Object.values(PERSONAL_PADS_CLIENT_MODULES)) {
      const text = String(safeReadFile(pathResolver.rootResolve(source), { encoding: 'utf8' }));
      expect(text).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/u);
      expect(text).not.toMatch(/window\.(?:prompt|confirm|alert)\(/u);
    }
    const app = String(
      safeReadFile(
        pathResolver.rootResolve(PERSONAL_PADS_CLIENT_MODULES['/personal-pads/app.js']),
        {
          encoding: 'utf8',
        }
      )
    );
    // Guards carried over from the inline runtime.
    for (const guard of [
      'pendingFileReads',
      'pendingArtifactReads',
      'draftRevision',
      'tierRequest',
      'tierSwitching',
      'artifactFieldRequest',
      'artifactFailedFields',
      'ui:dialog',
      'ui:sketch-board',
      'ui:voice-input',
      'ui:file-drop',
      'ui:save-bar',
      'disposeA2UI',
    ])
      expect(app).toContain(guard);
  });

  it('serves the kit assets and the runtime modules without a token', async () => {
    const context = createLocalPadContext({
      serviceId: 'personal-pads',
      sessionPrefix: 'assets-test',
      artifact_ref: 'local-pads',
      viewer_principal: 'human:alice',
      tier: 'public',
    });
    const server = createPersonalPadsServer(context, 'active/shared/tmp/personal-pads-test', 'tok');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers });
    try {
      for (const path of [
        '/personal-pads/app.js',
        '/personal-pads/support.js',
        '/pad-ui/pad-client.js',
      ]) {
        const response = await get(path);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('javascript');
      }
      expect((await get('/kyberion-ui.css')).status).toBe(200);
      // Only the allow-listed runtime modules are served; nothing else is readable.
      expect((await get('/personal-pads/server.ts')).status).not.toBe(200);
      expect((await get('/personal-pads/client/app.js')).status).not.toBe(200);
      const en = await (await get('/?lang=en')).text();
      expect(en).toContain('<html lang="en">');
      const ja = await (await get('/', { 'accept-language': 'ja' })).text();
      expect(ja).toContain('<html lang="ja">');
      const history = await get('/api/history?pad=memory-capture&lang=en', {
        'x-pads-token': 'tok',
      });
      expect(((await history.json()) as { storage_label: string }).storage_label).toBe(
        'Memory capture in the public scope'
      );
      const unknownPad = await get('/api/action-readiness?pad=nope&lang=ja', {
        'x-pads-token': 'tok',
      });
      expect(unknownPad.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('passes an injected surface contract through the shell seam', () => {
    const context = createLocalPadContext({
      serviceId: 'personal-pads',
      sessionPrefix: 'injected-test',
      artifact_ref: 'local-pads',
      viewer_principal: 'human:alice',
      tier: 'public',
    });
    const menu = [{ ...PERSONAL_PADS_SURFACE.getMenu()[0]!, label: 'Injected pad' }];
    const surface = {
      ...PERSONAL_PADS_SURFACE,
      getMenu: () => menu,
      getSurfaceContract: () => ({ ...PERSONAL_PADS_SURFACE.getSurfaceContract(), menu }),
      getTop: () => ({
        title: 'Injected desk',
        subtitle: 'Injected surface',
        scope: context.scope,
        viewer_principal: context.viewer_principal,
      }),
    };
    const page = personalPadsPage('test-token', context, surface);
    expect(page).toContain('Injected desk');
    expect(page).toContain('Injected pad');
    expect(page).not.toContain('Meeting notepad');
  });

  it('keeps handoff paths out of browser history projections', () => {
    const projected = toPublicPadRecord({
      record_id: 'memory-capture-test',
      pad_id: 'memory-capture',
      title: 'title',
      body: 'body',
      created_at: '2026-09-15T00:00:00.000Z',
      updated_at: '2026-09-15T00:00:00.000Z',
      viewer_principal: 'human:alice',
      scope: { scope_kind: 'system', tier: 'public' },
      tier: 'public',
      storage_policy_id: 'pad.public.v1',
      storage_policy_version: '1',
      adapter_id: 'memory-capture.v1',
      adapter_schema_version: '1',
      payload: {},
      artifact_manifest: [],
      artifact_refs: [],
      content_sha256: 'hash',
      handoff_ref: 'active/shared/secret/handoff.json',
    });
    expect(projected).not.toHaveProperty('handoff_ref');
  });

  it('uses the same safe projection for capture responses', () => {
    const source = toPublicPadRecord({
      record_id: 'memory-capture-write',
      pad_id: 'memory-capture',
      title: 'title',
      body: 'body',
      created_at: '2026-09-15T00:00:00.000Z',
      updated_at: '2026-09-15T00:00:00.000Z',
      viewer_principal: 'human:alice',
      scope: { scope_kind: 'system', tier: 'public' },
      tier: 'public',
      storage_policy_id: 'pad.public.v1',
      storage_policy_version: '1',
      adapter_id: 'memory-capture.v1',
      adapter_schema_version: '1',
      payload: {},
      artifact_manifest: [],
      artifact_refs: [],
      content_sha256: 'hash',
      handoff_ref: 'active/shared/secret/handoff.json',
    });
    expect(source).not.toHaveProperty('handoff_ref');
  });

  it('does not reflect repository paths from transport errors', () => {
    expect(
      toPublicRequestError(new Error('ENOENT: active/shared/secret/handoff.json'), 'ja')
    ).toEqual({
      code: 'storage_or_provider_error',
      message: '操作を完了できませんでした。設定と権限を確認してください。',
    });
    expect(toPublicRequestError(new Error('EACCES: /tmp/x'), 'en').message).toBe(
      'The operation could not be completed. Check the settings and permissions.'
    );
    expect(toPublicRequestError(new Error('record not found'))).toEqual({
      code: 'request_failed',
      message: 'record not found',
    });
  });
});
