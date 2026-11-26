import { describe, expect, it } from 'vitest';
import { resolvePipelineContextValues, resolveVars } from './logic-utils.js';
import { compileRunManifest } from './run-manifest.js';
import {
  formatArgsSuggestion,
  locateStepByEntryId,
  suggestArgsForPipelineDocument,
  suggestEvaluateStepArgs,
  suggestScriptArgsRewrite,
  ARGS_SUGGESTION_CAVEAT,
} from './run-manifest-args-suggest.js';

/** What the page would get from the templated script: naive substitution, then evaluation. */
async function runTemplated(script: string, context: Record<string, unknown>): Promise<unknown> {
  return await (0, eval)(String(resolveVars(script, context)));
}

/** What the page gets from the suggestion: a page function called with resolved args. */
async function runSuggested(
  script: string,
  args: Record<string, string>,
  context: Record<string, unknown>
): Promise<unknown> {
  const fn = (0, eval)(`(${script})`) as (input: unknown) => unknown;
  return await fn(resolvePipelineContextValues(args, context));
}

interface Fixture {
  name: string;
  script: string;
  context: Record<string, unknown>;
  expected?: { script: string; args: Record<string, string> };
}

const FIXTURES: Fixture[] = [
  {
    name: 'arrow IIFE with a whole string-literal template',
    script: "(() => '{{target}}'.split(' | ')[0])()",
    context: { target: 'R-17 | Travel expenses' },
    expected: {
      script: "(a) => String(a.target).split(' | ')[0]",
      args: { target: '{{target}}' },
    },
  },
  {
    name: 'block-bodied arrow IIFE with a bare value and a string template',
    script:
      "(() => { const ids = ['x1', 'x2', 'x3']; const id = ids[{{index}}]; if (id === '{{last_target_id}}') throw new Error('same target'); return id; })()",
    context: { index: 1, last_target_id: 'x1' },
    expected: {
      script:
        "(a) => { const ids = ['x1', 'x2', 'x3']; const id = ids[a.index]; if (id === String(a.last_target_id)) throw new Error('same target'); return id; }",
      args: { index: '{{index}}', last_target_id: '{{last_target_id}}' },
    },
  },
  {
    name: 'function IIFE with templates embedded in longer literals',
    script: '(function () { return \'id-{{x}}-end\' + "/{{y}}"; })()',
    context: { x: 42, y: 'tail' },
    expected: {
      script: "(a) => { return ('id-' + String(a.x) + '-end') + (\"/\" + String(a.y)); }",
      args: { x: '{{x}}', y: '{{y}}' },
    },
  },
  {
    name: 'bare expression with dotted and bracket paths',
    script: "'{{user.name}}'.toUpperCase() + ':' + {{items[1]}}",
    context: { user: { name: 'kai' }, items: [5, 7] },
    expected: {
      script: "(a) => (String(a.user_name).toUpperCase() + ':' + a.items_1)",
      args: { user_name: '{{user.name}}', items_1: '{{items[1]}}' },
    },
  },
  {
    name: 'async arrow IIFE',
    script: '(async () => { return {{count}} * 2; })()',
    context: { count: 21 },
    expected: { script: 'async (a) => { return a.count * 2; }', args: { count: '{{count}}' } },
  },
  {
    name: 'sanitized names that collide get a suffix',
    script: "(() => '{{a.b}}' + '{{a_b}}')()",
    context: { a: { b: 'dot' }, a_b: 'under' },
    expected: {
      script: '(a) => String(a.a_b) + String(a.a_b_2)',
      args: { a_b: '{{a.b}}', a_b_2: '{{a_b}}' },
    },
  },
  {
    name: 'a string default keeps working',
    script: "(() => '{{missing|none}}')()",
    context: {},
  },
  {
    name: 'an unset value is the empty string either way',
    script: "(() => '[' + '{{missing}}' + ']')()",
    context: {},
  },
  {
    name: 'the parameter avoids a name the script already uses',
    script: "(() => ['p', 'q'].map((a) => a + '{{suffix}}').join(','))()",
    context: { suffix: '!' },
  },
  {
    name: 'a regular expression and a division elsewhere in the script',
    script: "(() => /x+/.test('{{s}}') ? {{n}} / 2 : 0)()",
    context: { s: 'axxb', n: 9 },
  },
  {
    name: 'a regex after an if header',
    script: "(() => { if (true) /q/.test('q'); return '{{v}}'; })()",
    context: { v: 'ok' },
  },
  {
    name: 'escapes inside the literal are preserved',
    script: "(() => 'it\\'s {{x}}')()",
    context: { x: 'fine' },
  },
  {
    name: 'a JavaScript template literal elsewhere in the script',
    script: "(() => `v${1 + 1}` + '{{x}}')()",
    context: { x: '-x' },
  },
  {
    name: 'a regex with quote characters inside a template-literal expression',
    script: "(() => `${/['`]/.source}` + '{{x}}')()",
    context: { x: '!' },
  },
  {
    name: 'the IIFE ends in a semicolon',
    script: "(() => '{{x}}'.length)();",
    context: { x: 'abcd' },
  },
  {
    name: 'a function called with arguments stays an expression',
    script: "((x) => x + '{{y}}')(1)",
    context: { y: 'z' },
    expected: { script: '(a) => (((x) => x + String(a.y))(1))', args: { y: '{{y}}' } },
  },
  {
    name: 'an object-literal and array value spliced bare',
    script: '(() => JSON.stringify({ v: {{obj}}, w: {{list}} }))()',
    context: { obj: { k: 1 }, list: [1, 2] },
  },
];

describe('suggestScriptArgsRewrite', () => {
  for (const fixture of FIXTURES) {
    it(`round-trips: ${fixture.name}`, async () => {
      const suggestion = suggestScriptArgsRewrite(fixture.script);
      if ('reason' in suggestion) throw new Error(`declined: ${suggestion.reason}`);
      if (fixture.expected) {
        expect(suggestion.script).toBe(fixture.expected.script);
        expect(suggestion.args).toEqual(fixture.expected.args);
      }
      // The rewrite carries no template in its code.
      expect(suggestion.script).not.toContain('{{');
      const original = await runTemplated(fixture.script, fixture.context);
      const rewritten = await runSuggested(suggestion.script, suggestion.args, fixture.context);
      expect(rewritten).toEqual(original);
    });
  }

  it('passes page data as data where the splice was code injection', async () => {
    const script = "(() => '{{target}}'.length)()";
    const suggestion = suggestScriptArgsRewrite(script);
    if ('reason' in suggestion) throw new Error(suggestion.reason);
    const hostile = { target: "x'.length + (globalThis.pwned = 1) + '" };
    expect(await runSuggested(suggestion.script, suggestion.args, hostile)).toBe(
      hostile.target.length
    );
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  const DECLINES: Array<[string, string, RegExp]> = [
    ['template inside a regex', "(() => /{{x}}/.test('a'))()", /regular expression/u],
    ['template inside a template literal', '(() => `{{x}}`)()', /template literal/u],
    ['template inside ${} code', "(() => `${'{{x}}'}`)()", /template literal/u],
    ['template inside a line comment', '(() => { // {{x}}\n return 1; })()', /comment/u],
    ['template inside a block comment', '(() => { /* {{x}} */ return 1; })()', /comment/u],
    ['named function wrapper', "(function f() { return '{{x}}'; })()", /unknown wrapper/u],
    ['statements without a wrapper', "const x = '{{y}}'; x", /statement/u],
    ['this', "(() => this.title + '{{x}}')()", /`this`/u],
    ['arguments', "(function () { return arguments.length + '{{x}}'; })()", /`arguments`/u],
    ['bare token with a default', '(() => {{n|0}} + 1)()', /default outside a string/u],
    ['repository path token', "(() => '{{@knowledge:x.md}}')()", /repository path/u],
    ['filter-like token', "(() => '{{ x + 1 }}')()", /not a plain variable path/u],
    ['object key', "(() => ({ '{{k}}': 1 }))()", /object key/u],
    ['splice into an identifier', '(() => id{{x}})()', /longer token/u],
    ['splice after a member dot', '(() => obj.{{x}})()', /longer token/u],
    ['escape before the template', "(() => 'a\\{{x}}')()", /escape/u],
    ['ambiguous slash after a block', "(() => { if (x) {} /re/.test('{{y}}'); })()", /division/u],
    ['already a function', "(p) => p + '{{x}}'", /already a function/u],
    ['multi-line bare expression', "document.title\n+ '{{x}}'", /line break/u],
    [
      'trailing call after the arrow block',
      "(() => { return 1; }.call(null, '{{x}}'))()",
      /unknown wrapper/u,
    ],
  ];
  for (const [name, script, reason] of DECLINES) {
    it(`declines: ${name}`, () => {
      const suggestion = suggestScriptArgsRewrite(script);
      expect(suggestion.ok).toBe(false);
      if ('reason' in suggestion) expect(suggestion.reason).toMatch(reason);
    });
  }
});

describe('suggestEvaluateStepArgs', () => {
  it('only rewrites evaluate steps whose script alone is templated', () => {
    expect(
      suggestEvaluateStepArgs({
        op: 'browser:evaluate',
        params: { script: "(() => '{{x}}')()", args: { y: 1 } },
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/already passes args/u) });
    expect(
      suggestEvaluateStepArgs({ op: 'browser:cdp', params: { method: '{{m}}' } })
    ).toMatchObject({ ok: false });
    expect(
      suggestEvaluateStepArgs({
        op: 'browser:evaluate',
        params: { script: 'document.title', export_as: '{{name}}' },
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/export_as param/u) });
    expect(
      suggestEvaluateStepArgs({ op: 'evaluate', params: { script: "(() => '{{x}}')()" } })
    ).toMatchObject({ ok: true, script: '(a) => String(a.x)' });
  });

  it('makes the step pre-approvable in the Run Manifest', () => {
    const before = {
      op: 'browser:evaluate',
      params: { script: "(() => '{{target}}'.split(' | ')[0])()", export_as: 'first' },
    };
    const goto = { op: 'browser:goto', params: { url: 'https://app.example.test/' } };
    const compile = (step: unknown) =>
      compileRunManifest([goto, step], {
        inputPath: 'knowledge/confidential/fixture/x.json',
        contentSha256: 'h',
        scope: { tier: 'confidential', tenantSlug: 'fixture' },
      }).requirements.effects[1];
    expect(compile(before)).toMatchObject({
      bindable: false,
      unbindable_reason: 'templated_script',
    });
    const suggestion = suggestEvaluateStepArgs(before);
    if ('reason' in suggestion) throw new Error(suggestion.reason);
    const after = {
      ...before,
      params: { ...before.params, script: suggestion.script, args: suggestion.args },
    };
    expect(compile(after)).toMatchObject({ bindable: true });
  });
});

describe('pipeline document helpers', () => {
  const document = {
    pipeline_id: 'p',
    steps: [
      { op: 'browser:goto', params: { url: 'https://app.example.test/' } },
      {
        op: 'core:while',
        params: {
          max_iterations: 3,
          pipeline: [{ op: 'browser:evaluate', params: { script: "(() => '{{t}}')()" } }],
        },
      },
      {
        op: 'core:switch',
        params: {
          cases: [{ steps: [{ op: 'browser:evaluate', params: { script: '/{{r}}/.source' } }] }],
        },
        on_error: {
          fallback: [{ op: 'browser:evaluate', params: { script: '{{n}} + 1' } }],
        },
      },
    ],
  };

  it('locates steps by Run Manifest entry id', () => {
    expect(locateStepByEntryId(document.steps, '1.pipeline.0')).toBe(
      document.steps[1].params.pipeline?.[0]
    );
    expect(locateStepByEntryId(document.steps, '2.cases.0.steps.0')?.params).toEqual({
      script: '/{{r}}/.source',
    });
    expect(locateStepByEntryId(document.steps, '2.on_error.fallback.0')?.op).toBe(
      'browser:evaluate'
    );
    expect(locateStepByEntryId(document.steps, '9')).toBeUndefined();
  });

  it('rewrites a whole document without touching the input', () => {
    const snapshot = JSON.stringify(document);
    const { document: rewritten, results } = suggestArgsForPipelineDocument(document);
    expect(JSON.stringify(document)).toBe(snapshot);
    expect(results.map((result) => [result.step_path, result.suggestion.ok])).toEqual([
      ['1.pipeline.0', true],
      ['2.cases.0.steps.0', false],
      ['2.on_error.fallback.0', true],
    ]);
    const steps = (rewritten as typeof document).steps;
    expect(steps[1].params.pipeline?.[0].params).toEqual({
      script: '(a) => String(a.t)',
      args: { t: '{{t}}' },
    });
  });

  it('formats one compact, paste-ready line', () => {
    expect(formatArgsSuggestion('3', suggestScriptArgsRewrite("(() => '{{x}}')()"))).toBe(
      `step 3: "script": "(a) => String(a.x)", "args": {"x":"{{x}}"} — ${ARGS_SUGGESTION_CAVEAT}`
    );
    expect(formatArgsSuggestion('4', { ok: false, reason: 'why' })).toBe(
      'step 4: no args suggestion — why'
    );
  });
});
