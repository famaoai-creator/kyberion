import { describe, expect, it } from 'vitest';
import { createLocalPadContext } from '../lib/local-artifact-pad.js';
import {
  augmentPersonalPadsPage,
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

  it('renders the menu, scope context, and token-bound shell', () => {
    const context = createLocalPadContext({
      serviceId: 'personal-pads',
      sessionPrefix: 'test',
      artifact_ref: 'local-pads',
      viewer_principal: 'human:alice',
      tier: 'public',
    });
    const page = personalPadsPage('test-token', context);
    expect(page).toContain('Capture desk');
    expect(page).toContain('memory-capture');
    expect(page).toContain('X-Pads-Token');
    expect(page).toContain('tier');
    expect(page).toContain('pad-fields');
    expect(page).toContain('Meeting notepad');
    expect(page).toContain('drawing_data');
    expect(page).toContain('/api/capture?tier=');
    expect(page).toContain('pendingFileReads');
    expect(page).toContain('draftRevision');
    expect(page).toContain('tierRequest');
    expect(page).toContain('tierSwitching');
    expect(page).toContain('pendingArtifactReads');
    expect(page).toContain('artifactFieldRequest');
    expect(page).toContain('artifactFailedFields');
    expect(page).toContain("document.querySelectorAll('[data-field],[data-action-field]')");
    expect(page).toContain('描画を消去');
    expect(page).toContain('setScopeSwitching(true)');
    expect(page).toContain('履歴をコピーして編集できます');
    expect(page).toContain('template.replace(/\\{([a-z0-9_]+)\\}/gi');
    expect(page).toContain(
      'function updatePreview(){updateEditorPreview();syncAnnotationOverlays()}'
    );
    expect(page).not.toContain('originalUpdatePreview');
    expect(augmentPersonalPadsPage(page)).toContain('未保存の内容があります');
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
    expect(toPublicRequestError(new Error('ENOENT: active/shared/secret/handoff.json'))).toEqual({
      code: 'storage_or_provider_error',
      message: '操作を完了できませんでした。設定と権限を確認してください。',
    });
    expect(toPublicRequestError(new Error('record not found'))).toEqual({
      code: 'request_failed',
      message: 'record not found',
    });
  });
});
