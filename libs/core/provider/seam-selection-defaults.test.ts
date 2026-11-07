import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.fn();
vi.mock('../governance/audit-chain.js', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));
vi.mock('./provider-pins-store.js', () => ({
  loadSeamProviderPin: () => null,
  pinSeamProviderDecision: () => null,
}));

const { safeExistsSync, safeRmSync } = await import('../secure-io.js');
const defaults = await import('./seam-selection-defaults.js');
const selection = await import('./seam-provider-selection.js');
const { ProviderChainRouter } = await import('./provider-chain-router.js');

const {
  listSavedSeamDefaultLayers,
  parseSeamDefaultsEnv,
  resolveSavedSeamDefault,
  seamDefaultsOperatorPath,
  seamDefaultsScopePath,
  setSeamDefault,
  unsetSeamDefault,
} = defaults;

const TENANT = 'acme-seamdefaults';
const SCOPE = { tenant_slug: TENANT, organization_id: 'org-a', project_id: 'proj-a' };

function cleanup(): void {
  for (const file of [
    seamDefaultsOperatorPath(),
    seamDefaultsScopePath(TENANT),
    seamDefaultsScopePath(),
  ]) {
    safeRmSync(file, { force: true });
  }
}

describe('saved seam defaults store', () => {
  beforeEach(() => {
    cleanup();
    record.mockClear();
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', '');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('parses the env layer and drops malformed pairs', () => {
    expect(parseSeamDefaultsEnv('ocr-provider=tesseract; lease-backend = memory ,bad,=x')).toEqual({
      'ocr-provider': 'tesseract',
      'lease-backend': 'memory',
    });
  });

  it('layers env > project > organization > tenant > operator', () => {
    const seam = 'ocr-provider';
    setSeamDefault({ seam, provider: 'tesseract', layer: 'operator' });
    expect(resolveSavedSeamDefault(seam, SCOPE)).toMatchObject({
      provider: 'tesseract',
      layer: 'operator',
    });
    setSeamDefault({ seam, provider: 'apple_vision', layer: 'tenant', tenant_slug: TENANT });
    expect(resolveSavedSeamDefault(seam, SCOPE)?.layer).toBe('tenant');
    setSeamDefault({
      seam,
      provider: 'llm_api',
      layer: 'organization',
      tenant_slug: TENANT,
      organization_id: 'org-a',
    });
    expect(resolveSavedSeamDefault(seam, SCOPE)?.layer).toBe('organization');
    setSeamDefault({
      seam,
      provider: 'local_vlm',
      layer: 'project',
      tenant_slug: TENANT,
      project_id: 'proj-a',
    });
    expect(resolveSavedSeamDefault(seam, SCOPE)).toMatchObject({
      provider: 'local_vlm',
      layer: 'project',
    });
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'ocr-provider=windows_native');
    expect(listSavedSeamDefaultLayers(seam, SCOPE).map((layer) => layer.layer)).toEqual([
      'env',
      'project',
      'organization',
      'tenant',
      'operator',
    ]);
    // Another tenant's scope never sees this tenant's layers.
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', '');
    expect(resolveSavedSeamDefault(seam, { tenant_slug: 'other-tenant' })?.layer).toBe('operator');
    // Unrelated project / organization fall back to the tenant layer.
    expect(
      resolveSavedSeamDefault(seam, { tenant_slug: TENANT, project_id: 'proj-b' })?.layer
    ).toBe('tenant');
  });

  it('keeps the tenant partition out of the operator file and audits changes', () => {
    setSeamDefault({
      seam: 'lease-backend',
      provider: 'memory',
      layer: 'tenant',
      tenant_slug: TENANT,
    });
    expect(safeExistsSync(seamDefaultsOperatorPath())).toBe(false);
    expect(seamDefaultsScopePath(TENANT)).toContain(
      `seam-selection-defaults/confidential/${TENANT}/defaults.json`
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'seam_selection_default_change' })
    );
    expect(unsetSeamDefault({ seam: 'lease-backend', layer: 'tenant', tenant_slug: TENANT })).toBe(
      true
    );
    expect(unsetSeamDefault({ seam: 'lease-backend', layer: 'tenant', tenant_slug: TENANT })).toBe(
      false
    );
    expect(resolveSavedSeamDefault('lease-backend', { tenant_slug: TENANT })).toBeNull();
  });

  it('rejects a tenant layer without a tenant and invalid ids', () => {
    expect(() => setSeamDefault({ seam: 'x', provider: 'y', layer: 'tenant' })).toThrow(
      /SEAM_DEFAULT_INVALID/
    );
    expect(() =>
      setSeamDefault({ seam: 'x', provider: 'y', layer: 'project', project_id: '../evil' })
    ).toThrow(/SEAM_DEFAULT_INVALID/);
  });
});

describe('saved defaults in governed selection', () => {
  beforeEach(() => {
    cleanup();
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', '');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  const OCR = [
    { id: 'windows_native', eligible: false, unmet: ['platform'] },
    { id: 'apple_vision', eligible: true },
    { id: 'llm_api', eligible: true },
    { id: 'tesseract', eligible: true },
  ];

  it('opts a no-purpose call into governed selection and leads with the saved default', () => {
    expect(selection.resolveSeamSelectionEntry({ seam: 'ocr-provider' }).kind).toBe('legacy');
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'ocr-provider=tesseract');
    expect(selection.resolveSeamSelectionEntry({ seam: 'ocr-provider' }).kind).toBe('governed');
    const decision = selection.explainSeamProviderDecision({
      seam: 'ocr-provider',
      candidates: OCR,
    });
    expect(decision).toMatchObject({
      provider_id: 'tesseract',
      strategy: 'default',
      default_source: 'env',
    });
    // The remainder keeps the policy chain order, not alphabetical order.
    expect(decision.ranked).toEqual(['tesseract', 'apple_vision', 'llm_api']);
  });

  it('never overrides an explicit provider or a purpose', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'ocr-provider=tesseract');
    expect(
      selection.resolveSeamSelectionEntry({ seam: 'ocr-provider', explicitProvider: 'llm_api' })
    ).toEqual({ kind: 'explicit', providerId: 'llm_api' });
    const purposes = selection.listSeamSelectionPurposes('ocr-provider');
    if (purposes.length) {
      const decision = selection.explainSeamProviderDecision({
        seam: 'ocr-provider',
        purpose: purposes[0],
        candidates: OCR,
      });
      expect(decision.strategy).toBe('purpose');
      expect(decision.default_source).toBeUndefined();
    }
  });

  it('falls back to the policy default with a note when the saved default cannot run', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'ocr-provider=windows_native');
    const decision = selection.explainSeamProviderDecision({
      seam: 'ocr-provider',
      candidates: OCR,
    });
    expect(decision.provider_id).toBe('apple_vision');
    expect(decision.default_source).toBe('policy');
    expect(decision.rationale).toContain("saved default (env) 'windows_native' cannot run");
  });

  it('a caller-configured default still wins over the saved default', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'ocr-provider=tesseract');
    const decision = selection.explainSeamProviderDecision({
      seam: 'ocr-provider',
      defaultProvider: 'llm_api',
      candidates: OCR,
    });
    expect(decision).toMatchObject({ provider_id: 'llm_api', default_source: 'caller' });
  });

  it('policy default is the first eligible provider of the default chain', () => {
    const decision = selection.explainSeamProviderDecision({
      seam: 'ocr-provider',
      candidates: OCR,
    });
    expect(decision).toMatchObject({ provider_id: 'apple_vision', default_source: 'policy' });
  });

  it('resolveSeamDefaultOrder / resolveSeamDefaultProvider put the saved default first', () => {
    expect(selection.resolveSeamDefaultOrder('lease-backend', { builtin: ['x'] })[0]).toBe(
      'local-file-lock'
    );
    expect(selection.resolveSeamDefaultOrder('no-such-seam', { builtin: ['x', 'y'] })).toEqual([
      'x',
      'y',
    ]);
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'lease-backend=memory');
    expect(selection.resolveSeamDefaultOrder('lease-backend')).toEqual([
      'memory',
      'local-file-lock',
    ]);
    expect(selection.resolveSeamDefaultProvider('lease-backend')).toEqual({
      provider: 'memory',
      source: 'env',
    });
    expect(
      selection.resolveSeamDefaultProvider('lease-backend', { eligible: (id) => id !== 'memory' })
    ).toEqual({ provider: 'local-file-lock', source: 'policy' });
  });

  it('security seams opt out of saved defaults (allow_saved_default: false)', () => {
    vi.stubEnv(
      'KYBERION_SEAM_DEFAULTS',
      'authz-policy-engine=deny-all;authn-principal-resolver=stub;lease-backend=memory'
    );
    expect(selection.savedSeamDefaultFor('authz-policy-engine')).toBeNull();
    expect(selection.savedSeamDefaultFor('authn-principal-resolver')).toBeNull();
    expect(selection.savedSeamDefaultFor('lease-backend')?.provider).toBe('memory');
    expect(selection.resolveSeamSelectionEntry({ seam: 'authz-policy-engine' }).kind).toBe(
      'legacy'
    );
  });

  it('a provider chain router lets the saved default lead the policy chain', async () => {
    const providers = OCR.map((candidate) => ({ id: candidate.id }));
    const router = new ProviderChainRouter(providers, {
      seam: 'ocr-provider',
      label: '[test]',
      errorTag: '[TEST]',
      eligibility: async () => OCR,
    });
    expect(await router.resolveProviderIds({})).toEqual(['apple_vision', 'llm_api', 'tesseract']);
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'ocr-provider=tesseract');
    expect(await router.resolveProviderIds({})).toEqual(['tesseract', 'apple_vision', 'llm_api']);
  });
});
