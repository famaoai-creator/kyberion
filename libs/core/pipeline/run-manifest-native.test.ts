import { describe, expect, it } from 'vitest';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { assessPipelineReadiness, type PipelineReadinessDeps } from './pipeline-readiness.js';
import { compileRunManifest, describeRunManifest } from './run-manifest.js';
import {
  BROWSER_NATIVE_FORMAT,
  isNativeBrowserPipelineDocument,
  nativeBrowserManifestSteps,
  nativeWritePath,
} from './run-manifest-native.js';
import type { RunScope } from './run-scope.js';

const INPUT = 'knowledge/confidential/acme/browser-workflows/scenarios/native.json';
const OPTIONS = {
  inputPath: INPUT,
  contentSha256: 'n'.repeat(64),
  scope: { tier: 'confidential', tenantSlug: 'acme' },
};

/** Synthetic native browser pipeline: bare ops, authored step types, if / while bodies. */
const NATIVE = {
  action: 'pipeline',
  session_id: 'native-session',
  options: { headless: true, keep_alive: true },
  context: { portal_url: 'https://portal.example.test/' },
  steps: [
    { id: 'open', type: 'capture', op: 'goto', params: { url: '{{portal_url}}login' } },
    { id: 'settle', type: 'apply', op: 'wait', params: { duration: 100 } },
    { id: 'user', type: 'apply', op: 'fill', params: { selector: '#user', text: 'operator' } },
    {
      id: 'pass',
      type: 'apply',
      op: 'fill',
      params: { selector: '#password', text: '{{env.PORTAL_PASSWORD}}' },
    },
    {
      id: 'maybe',
      type: 'control',
      op: 'if',
      params: {
        condition: { from: 'needs_login', operator: 'eq', value: true },
        then: [
          {
            type: 'apply',
            op: 'click_first_match',
            params: { selectors: ['#login', 'button[type=submit]'] },
          },
        ],
        else: [{ type: 'capture', op: 'evaluate', params: { script: 'document.title' } }],
      },
    },
    {
      id: 'poll',
      type: 'control',
      op: 'while',
      params: {
        condition: { from: 'pending', operator: 'eq', value: true },
        max_iterations: 4,
        pipeline: [
          {
            type: 'capture',
            op: 'evaluate',
            params: { script: '(a) => a.n', args: { n: '{{pending}}' }, export_as: 'pending' },
          },
        ],
      },
    },
    { id: 'note', type: 'apply', op: 'log', params: { message: 'done' } },
  ],
};

const compileNative = (steps: unknown[] = NATIVE.steps, options = {}) =>
  compileRunManifest(steps, {
    ...OPTIONS,
    context: NATIVE.context,
    format: BROWSER_NATIVE_FORMAT,
    ...options,
  });

interface ViewStep {
  op: string;
  params: { then?: ViewStep[]; else?: ViewStep[]; pipeline?: ViewStep[] };
}

describe('native browser pipeline detection', () => {
  it('recognises the native contract and leaves pipeline ADF alone', () => {
    expect(isNativeBrowserPipelineDocument(NATIVE)).toBe(true);
    // Mixed bare and qualified browser ops are still native.
    expect(
      isNativeBrowserPipelineDocument({
        ...NATIVE,
        steps: [...NATIVE.steps, { type: 'apply', op: 'browser:click', params: {} }],
      })
    ).toBe(true);
    // An ADF: qualified ops, no step types.
    expect(
      isNativeBrowserPipelineDocument({
        action: 'pipeline',
        steps: [{ op: 'browser:goto', params: { url: 'https://x.example.test/' } }],
      })
    ).toBe(false);
    // All-qualified browser ops are runnable by `pnpm pipeline`: treated as ADF.
    expect(
      isNativeBrowserPipelineDocument({
        action: 'pipeline',
        steps: [{ type: 'capture', op: 'browser:goto', params: {} }],
      })
    ).toBe(false);
    expect(
      isNativeBrowserPipelineDocument({
        action: 'pipeline',
        steps: [
          { type: 'apply', op: 'system:log', params: {} },
          { type: 'apply', op: 'wait' },
        ],
      })
    ).toBe(false);
    expect(isNativeBrowserPipelineDocument({ ...NATIVE, action: 'run' })).toBe(false);
    expect(isNativeBrowserPipelineDocument({ ...NATIVE, steps: [] })).toBe(false);
  });

  it('views every native body as browser:* steps', () => {
    const view = nativeBrowserManifestSteps(NATIVE.steps) as ViewStep[];
    expect(view.map((step) => step.op)).toEqual([
      'browser:goto',
      'browser:wait',
      'browser:fill',
      'browser:fill',
      'browser:if',
      'browser:while',
      'browser:log',
    ]);
    expect(view[4].params.then?.[0].op).toBe('browser:click_first_match');
    expect(view[4].params.else?.[0].op).toBe('browser:evaluate');
    expect(view[5].params.pipeline?.[0].op).toBe('browser:evaluate');
    // The authored step is not mutated.
    expect(NATIVE.steps[0].op).toBe('goto');
  });
});

describe('compileRunManifest — native browser pipeline', () => {
  it('compiles bare ops as browser effects with the nested entry ids the runtime tags', () => {
    const manifest = compileNative();
    expect(manifest.source).toEqual({
      input_path: INPUT,
      content_sha256: 'n'.repeat(64),
      format: 'browser_native',
    });
    expect(manifest.complete).toBe(true);
    expect(manifest.requirements.model).toBe(false);
    const entries = manifest.requirements.effects.map((entry) => [
      entry.entry_id,
      entry.operation_id,
      entry.max_occurrences,
      entry.bindable,
    ]);
    expect(entries).toEqual([
      ['0', 'browser:goto', 1, true],
      ['2', 'browser:fill', 1, true],
      ['3', 'browser:fill', 1, true],
      ['4.then.0', 'browser:click_first_match', 1, true],
      ['4.else.0', 'browser:evaluate', 1, true],
      // browser:while: each body step up to max_iterations times.
      ['5.pipeline.0', 'browser:evaluate', 4, true],
    ]);
    const open = manifest.requirements.effects[0];
    expect(open.target).toEqual({ kind: 'url', url: 'https://portal.example.test/login' });
    expect(manifest.requirements.effects[1].origins).toEqual(['https://portal.example.test']);
  });

  it('hashes the params exactly as the native engine hands them to the op', () => {
    const manifest = compileNative();
    const hash = (id: string) =>
      manifest.requirements.effects.find((entry) => entry.entry_id === id)?.params_template_hash;
    expect(hash('0')).toBe(computeApprovalPayloadHash(NATIVE.steps[0].params));
    expect(hash('5.pipeline.0')).toBe(
      computeApprovalPayloadHash({
        script: '(a) => a.n',
        args: { n: '{{pending}}' },
        export_as: 'pending',
      })
    );
    // A native step's `produces` is not stamped into its params (the runner's ADF shaping).
    const withProduces = compileNative([
      { ...NATIVE.steps[0] },
      {
        type: 'capture',
        op: 'evaluate',
        produces: 'title',
        params: { script: 'document.title' },
      },
    ]);
    expect(withProduces.requirements.effects[1].params_template_hash).toBe(
      computeApprovalPayloadHash({ script: 'document.title' })
    );
  });

  it('admits by the authored step type, as the native engine dispatches', () => {
    // `wait` / `log` are reads under apply; a capture-typed evaluate is a page script.
    const manifest = compileNative();
    expect(manifest.requirements.effects.map((entry) => entry.entry_id)).not.toContain('1');
    expect(manifest.requirements.effects.map((entry) => entry.entry_id)).not.toContain('6');
  });

  it('keeps per-step approval for what the native runtime cannot bound', () => {
    const manifest = compileNative([
      { type: 'capture', op: 'goto', params: { url: '{{dynamic_host}}' } },
      { type: 'control', op: 'ref', params: { path: 'fragments/x.json' } },
      {
        type: 'control',
        op: 'while',
        params: {
          condition: { from: 'x', operator: 'exists' },
          pipeline: [{ type: 'apply', op: 'click', params: { selector: '#next' } }],
        },
      },
    ]);
    expect(manifest.requirements.effects[0]).toMatchObject({
      bindable: false,
      unbindable_reason: 'templated_host',
    });
    // No max_iterations: the browser loop runs up to 100 times.
    expect(manifest.requirements.effects[1]).toMatchObject({
      entry_id: '2.pipeline.0',
      max_occurrences: 100,
    });
    expect(manifest.complete).toBe(false);
    expect(manifest.incomplete_reasons.join(' ')).toContain('browser:ref');
  });

  it('classifies the file options with the shared classifier', () => {
    const manifest = compileNative(NATIVE.steps, {
      pipelineOptions: {
        headless: true,
        navigation_policy: { allow_private_network: true },
        user_data_dir: 'active/shared/runtime/browser/profiles/confidential/acme/portal',
        connect_over_cdp: true,
      },
    });
    expect(manifest.requirements.browser_navigation).toEqual({ allow_private_network: true });
    expect(manifest.requirements.browser_profile).toEqual({
      user_data_dir: 'active/shared/runtime/browser/profiles/confidential/acme/portal',
    });
    // A profile outside the run's partition is dropped: the bound run uses
    // its session's implicit profile inside the partition instead.
    const outside = compileNative(NATIVE.steps, {
      pipelineOptions: { user_data_dir: 'active/shared/runtime/browser/portal' },
    });
    expect(outside.requirements.browser_profile).toEqual({
      user_data_dir: 'active/shared/runtime/browser/profiles/confidential/acme/session-default',
      session_id: 'default',
    });
  });

  it('detects a model-calling native op', () => {
    const manifest = compileNative([
      { type: 'capture', op: 'goto', params: { url: 'https://portal.example.test/' } },
      { type: 'capture', op: 'llm_decide', params: { goal: 'pick' } },
    ]);
    expect(manifest.requirements.model).toBe(true);
  });

  it('binds the format: the same steps as ADF compile to a different manifest', () => {
    const steps = [
      { type: 'capture', op: 'browser:goto', params: { url: 'https://portal.example.test/' } },
    ];
    const native = compileNative(steps);
    const adf = compileRunManifest(steps, OPTIONS);
    expect(adf.source.format).toBeUndefined();
    expect(native.manifest_hash).not.toBe(adf.manifest_hash);
  });

  it('tells the approver the browser actuator runs the file', () => {
    const lines = describeRunManifest(compileNative(), { steps: NATIVE.steps });
    expect(lines).toContain('Runner: the browser actuator (native browser pipeline)');
    expect(lines.join('\n')).toContain(
      'Click the first match of 2 selectors on portal.example.test'
    );
  });
});

describe('pipeline check — native browser pipeline', () => {
  const scope: RunScope = {
    input_path: INPUT,
    tier: 'confidential',
    tenant_slug: 'acme',
    source: 'location',
  };
  const deps: PipelineReadinessDeps = {
    deriveScope: () => scope,
    findTrustApproval: () => {
      throw new Error('a native file never consults file-only trust');
    },
    findManifestApproval: () => null,
    manifestRunUsage: () => ({ runs_today: 1, runs_per_day: 20 }),
    resolvePrincipal: () => ({ mode: 'attended', memberId: 'owner', reason: 'terminal' }),
  };
  const input = (approval: string | null) => ({
    report: assessPipelineReadiness(
      {
        inputPath: INPUT,
        pipeline: { ...NATIVE, steps: nativeBrowserManifestSteps(NATIVE.steps) } as never,
        manifestSource: {
          sourceText: JSON.stringify(NATIVE),
          pipeline: NATIVE,
          format: BROWSER_NATIVE_FORMAT,
        },
        hasHuman: true,
      },
      { ...deps, findManifestApproval: () => approval }
    ),
  });
  const row = (report: ReturnType<typeof assessPipelineReadiness>, id: string) =>
    report.checks.find((check) => check.id === id);

  it('reports manifest coverage and asks for a manifest approval without blocking', () => {
    const { report } = input(null);
    expect(row(report, 'effects')?.message).toMatch(/^6 external step\(s\), 6 pre-approvable/u);
    expect(row(report, 'trust')).toMatchObject({
      status: 'warning',
      next: `pnpm kyberion project-trust request ${INPUT}, then pnpm kyberion approvals --approve <request-id>`,
    });
    expect(row(report, 'browser')?.status).toBe('pass');
    expect(report.verdict).not.toBe('blocked');
  });

  it('passes trust with the browser run command once the manifest is approved', () => {
    const { report } = input('req-native');
    expect(row(report, 'trust')).toMatchObject({
      status: 'pass',
      next: `pnpm kyberion browser run --adf ${INPUT}`,
    });
    expect(row(report, 'trust')?.message).toContain('1/20 runs today');
  });
});

describe('compileRunManifest — {{env.X}} credentials', () => {
  const GOTO = {
    type: 'capture',
    op: 'goto',
    params: { url: 'https://portal.example.test/login' },
  };
  const FILL = {
    type: 'apply',
    op: 'fill',
    params: { selector: '#password', text: '{{env.PORTAL_PASSWORD}}' },
  };

  it('pins an env credential to the page it was authored for and says so on the card', () => {
    const manifest = compileNative([GOTO, FILL]);
    const fill = manifest.requirements.effects[1];
    expect(fill.argument_origins.text).toBe('secret:env/PORTAL_PASSWORD');
    expect(fill.secret_origins).toEqual({ 'env/PORTAL_PASSWORD': ['https://portal.example.test'] });
    expect(fill.bindable).toBe(true);
    const lines = describeRunManifest(manifest, { steps: [GOTO, FILL] });
    expect(lines).toContain('Secrets: environment variable PORTAL_PASSWORD (credential)');
    expect(lines).toContain(
      'Type the value of environment variable PORTAL_PASSWORD (credential) into #password on portal.example.test once'
    );
  });

  it('applies the secret rules: no page yet, a templated or frame selector, a credential in the URL', () => {
    expect(compileNative([FILL]).requirements.effects[0].unbindable_reason).toBe(
      'secret_origin_unknown'
    );
    for (const selector of ['{{field}}', 'iframe >> #password'])
      expect(
        compileNative([GOTO, { ...FILL, params: { ...FILL.params, selector } }]).requirements
          .effects[1].unbindable_reason
      ).toBe('unsafe_secret_selector');
    const leak = compileNative([
      {
        type: 'capture',
        op: 'goto',
        params: { url: 'https://portal.example.test/?t={{env.TOKEN}}' },
      },
    ]);
    expect(leak.requirements.effects[0]).toMatchObject({
      bindable: false,
      unbindable_reason: 'credential_in_url',
    });
    expect(describeRunManifest(leak).join('\n')).toContain(
      'it puts a credential into the address it opens'
    );
  });

  it('names a credential any other step carries', () => {
    const type = {
      type: 'apply',
      op: 'type',
      params: { selector: '#otp', text: 'x{{env.OTP_SEED}}' },
    };
    const lines = describeRunManifest(compileNative([GOTO, type]), { steps: [GOTO, type] });
    expect(lines.join('\n')).toContain(
      'carries the value of environment variable OTP_SEED (credential) (only to portal.example.test)'
    );
  });

  it('treats {{env.X}} the same way in a pipeline ADF', () => {
    const manifest = compileRunManifest(
      [
        { op: 'browser:goto', params: { url: 'https://portal.example.test/' } },
        { op: 'browser:fill', params: { selector: '#pw', text: '{{env.PORTAL_PASSWORD}}' } },
      ],
      OPTIONS
    );
    expect(manifest.requirements.effects[1].secret_origins).toEqual({
      'env/PORTAL_PASSWORD': ['https://portal.example.test'],
    });
  });
});

describe('compileRunManifest — raw step positions and implicit profile', () => {
  it('numbers entries by the raw array index (a malformed step keeps its slot)', () => {
    const manifest = compileNative([
      { type: 'capture', op: 'goto', params: { url: 'https://portal.example.test/' } },
      { note: 'not a step' },
      'nor this',
      { type: 'apply', op: 'click', params: { selector: '#go' } },
      {
        type: 'control',
        op: 'if',
        params: {
          condition: { from: 'x', operator: 'exists' },
          then: [{ op_missing: true }, { type: 'apply', op: 'click', params: { selector: '#y' } }],
        },
      },
    ]);
    expect(manifest.requirements.effects.map((entry) => entry.entry_id)).toEqual([
      '0',
      '3',
      '4.then.1',
    ]);
  });

  it("shows the session's persistent profile and a data: URL allowance on the card", () => {
    const manifest = compileNative(NATIVE.steps, {
      sessionId: 'portal',
      pipelineOptions: { navigation_policy: { allow_data_url: true } },
    });
    expect(manifest.requirements.browser_profile).toEqual({
      user_data_dir: 'active/shared/runtime/browser/profiles/confidential/acme/session-portal',
      session_id: 'portal',
    });
    expect(manifest.requirements.browser_navigation).toEqual({ allow_data_url: true });
    const lines = describeRunManifest(manifest);
    expect(lines).toContain(
      'Browser: uses the persistent profile active/shared/runtime/browser/profiles/confidential/acme/session-portal of browser session "portal" (keeps its logins between runs)'
    );
    expect(lines).toContain(
      'Browser: allows navigation to data: URLs (pages built from inline content)'
    );
    // A session id that is not a plain segment is hashed, never used as a path.
    expect(
      compileNative(NATIVE.steps, { sessionId: '../x' }).requirements.browser_profile?.user_data_dir
    ).toMatch(/\/session-sha256-[0-9a-f]{16}$/u);
  });
});

describe('step-authored file writes in native runs', () => {
  const ACME = { tier: 'confidential', tenant_slug: 'acme' };
  const SCRATCH = 'active/shared/tmp/confidential/acme/browser';

  it('judges the written path statically against the run partition', () => {
    const shot = (path?: string) =>
      nativeWritePath('screenshot', path === undefined ? {} : { path }, ACME);
    expect(shot(`${SCRATCH}/a.png`)?.confined).toBe(true);
    expect(shot('active/shared/artifacts/confidential/acme/browser/run/a.png')?.confined).toBe(
      true
    );
    expect(shot('evidence/browser/a.png')?.confined).toBe(true);
    // The default screenshot directory is a write root.
    expect(shot()?.confined).toBe(true);
    // A templated file name inside a literal root directory stays confined.
    expect(shot(`${SCRATCH}/{{run_id}}.png`)?.confined).toBe(true);
    expect(shot('active/shared/tmp/a.png')).toEqual({
      path: 'active/shared/tmp/a.png',
      confined: false,
      suggested_path: `${SCRATCH}/a.png`,
    });
    for (const outside of [
      '{{dir}}/a.png',
      `${SCRATCH}/../../other/browser/a.png`,
      '/tmp/a.png',
      'active/shared/tmp/confidential/other/browser/a.png',
      SCRATCH,
    ])
      expect(shot(outside)?.confined, outside).toBe(false);
    // Exports default to the shared scratch root; a handoff without a path writes nothing.
    expect(nativeWritePath('export_adf', {}, ACME, 'portal')).toEqual({
      path: 'active/shared/tmp/browser/portal-pipeline.json',
      confined: false,
      suggested_path: `${SCRATCH}/portal-pipeline.json`,
    });
    expect(nativeWritePath('export_session_handoff', {}, ACME)).toBeUndefined();
    // A failure bundle (page snapshot, console and network events) is a step file too.
    expect(nativeWritePath('export_failure_bundle', {}, ACME, 'a/b')).toEqual({
      path: 'active/shared/tmp/browser/a_b-failure-bundle.json',
      confined: false,
      suggested_path: `${SCRATCH}/a_b-failure-bundle.json`,
    });
    expect(
      nativeWritePath('export_failure_bundle', { path: 'knowledge/public/x.json' }, ACME)?.confined
    ).toBe(false);
    expect(
      nativeWritePath('export_failure_bundle', { path: `${SCRATCH}/bundle.json` }, ACME)?.confined
    ).toBe(true);
    expect(nativeWritePath('click', { path: 'x' }, ACME)).toBeUndefined();
  });

  const GOTO = { type: 'capture', op: 'goto', params: { url: 'https://portal.example.test/' } };
  const UNCONFINED = {
    type: 'capture',
    op: 'screenshot',
    params: { path: 'active/shared/tmp/a.png' },
  };
  const CONFINED = { type: 'capture', op: 'screenshot', params: { path: `${SCRATCH}/b.png` } };

  it('marks an unconfined write per-step and shows the confined path to use', () => {
    const manifest = compileNative([GOTO, UNCONFINED, CONFINED]);
    expect(manifest.requirements.effects.map((entry) => entry.entry_id)).toEqual(['0', '1']);
    expect(manifest.requirements.effects[1]).toMatchObject({
      operation_id: 'browser:write_file',
      bindable: false,
      unbindable_reason: 'write_path_unconfined',
      write: { path: 'active/shared/tmp/a.png', suggested_path: `${SCRATCH}/a.png` },
    });
    expect(describeRunManifest(manifest, { steps: [GOTO, UNCONFINED, CONFINED] })).toContain(
      `Will still ask per step: step 1 writes active/shared/tmp/a.png outside the run's partition — to pre-approve it, write it under ${SCRATCH}/a.png`
    );
    // An ADF manifest never carries native write entries.
    expect(
      compileRunManifest(
        [{ op: 'browser:screenshot', params: { path: 'active/shared/tmp/a.png' } }],
        OPTIONS
      ).requirements.effects
    ).toEqual([]);
  });

  it('prints the confined path per step in pipeline check', () => {
    const file = { ...NATIVE, steps: [GOTO, UNCONFINED] };
    const report = assessPipelineReadiness(
      {
        inputPath: INPUT,
        pipeline: { ...file, steps: nativeBrowserManifestSteps(file.steps) } as never,
        manifestSource: {
          sourceText: JSON.stringify(file),
          pipeline: file,
          format: BROWSER_NATIVE_FORMAT,
        },
        hasHuman: true,
      },
      {
        deriveScope: () => ({
          input_path: INPUT,
          tier: 'confidential',
          tenant_slug: 'acme',
          source: 'location',
        }),
        findManifestApproval: () => null,
        resolvePrincipal: () => ({ mode: 'attended', memberId: 'owner', reason: 'terminal' }),
      }
    );
    const effects = report.checks.find((check) => check.id === 'effects');
    expect(effects?.message).toContain('1 browser:write_file (write_path_unconfined)');
    expect(effects?.details).toContain(
      `step 1: writes active/shared/tmp/a.png outside the run's partition — set its path to ${SCRATCH}/a.png to pre-approve it`
    );
  });
});
