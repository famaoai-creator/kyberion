import { describe, expect, it } from 'vitest';
import {
  applyJsonTextEdits,
  insertMemberEdit,
  replaceValueEdit,
  scanJsonSource,
  unifiedDiffForEdits,
} from './json-source-edit.js';
import { planPipelineFix } from './pipeline-fix.js';
import { ARGS_SUGGESTION_CAVEAT } from './run-manifest-args-suggest.js';

const SCOPE = {
  input_path: 'knowledge/confidential/acme/browser-workflows/scenarios/fix.json',
  tier: 'confidential' as const,
  tenant_slug: 'acme',
};
const PROFILES = 'active/shared/runtime/browser/profiles/confidential/acme';
const SCRATCH = 'active/shared/tmp/confidential/acme/browser';

/** Synthetic ADF: a big integer and hand formatting that must survive byte for byte. */
const ADF_TEXT = `{
  "pipeline_id": "fix-adf",
  "context": { "limit": 12345678901234567890 },
  "options": { "user_data_dir": "active/shared/runtime/browser/portal", "headless": true },
  "steps": [
    { "id": "open", "op": "browser:goto", "params": { "url": "https://app.example.test/" } },
    {
      "id": "pick",
      "op": "browser:evaluate",
      "params": {
        "script": "(() => '{{target}}'.split(' | ')[0])()",
        "export_as": "first"
      }
    },
    {
      "id": "token",
      "op": "browser:evaluate",
      "params": { "script": "(() => fetch('/api', { headers: { t: '{{env.PORTAL_TOKEN}}' } }))()" }
    }
  ]
}
`;

/** Synthetic native browser pipeline: bare ops, a while body, an out-of-partition screenshot. */
const NATIVE_TEXT = `{
  "action": "pipeline",
  "session_id": "fix-native",
  "options": { "headless": false, "user_data_dir": "active/shared/runtime/browser/flow" },
  "steps": [
    { "type": "capture", "op": "goto", "params": { "url": "https://portal.example.test/" } },
    {
      "type": "control",
      "op": "while",
      "params": {
        "condition": { "from": "pending", "operator": "eq", "value": true },
        "max_iterations": 3,
        "pipeline": [
          {
            "type": "capture",
            "op": "evaluate",
            "params": { "script": "document.querySelector('#row-{{row}}') !== null", "export_as": "pending" }
          }
        ]
      }
    },
    { "type": "capture", "op": "screenshot", "params": { "path": "evidence/screens/done.png" } },
    { "type": "capture", "op": "export_playwright", "params": {} }
  ]
}
`;

describe('json-source-edit', () => {
  it('records value spans, detects duplicate keys and edits without re-serializing', () => {
    const text = '{ "a": 12345678901234567890, "b": { "c": "x" } }';
    const map = scanJsonSource(text);
    expect(map.duplicateKeys).toEqual([]);
    const edited = applyJsonTextEdits(text, [
      replaceValueEdit(map, ['b', 'c'], '"y"'),
      insertMemberEdit(map, ['b'], 'd', '1', 'c'),
    ]);
    expect(edited).toBe('{ "a": 12345678901234567890, "b": { "c": "y", "d": 1 } }');
    expect(scanJsonSource('{"a":1,"a":2}').duplicateKeys).toEqual(['a']);
    expect(() => scanJsonSource('{"a":1,}')).toThrow(/invalid JSON/u);
  });

  it('prints a unified diff of only the changed lines', () => {
    const text = 'line1\n  "k": "old",\nline3\n';
    const start = text.indexOf('"old"');
    const diff = unifiedDiffForEdits(
      text,
      [{ start, end: start + 5, text: '"new"' }],
      { from: 'a/f', to: 'b/f' },
      { context: 0 }
    );
    expect(diff).toEqual([
      '--- a/f',
      '+++ b/f',
      '@@ -2,1 +2,1 @@',
      '-  "k": "old",',
      '+  "k": "new",',
    ]);
  });
});

describe('planPipelineFix', () => {
  it('rewrites an ADF templated script and its profile, leaving the credential script manual', () => {
    const plan = planPipelineFix({ sourceText: ADF_TEXT, scope: SCOPE });
    expect(plan.format).toBe('adf');
    expect(plan.refusal).toBeUndefined();
    expect(plan.before).toMatchObject({ external: 3, pre_approvable: 1 });
    expect(plan.after).toMatchObject({ external: 3, pre_approvable: 2 });
    expect(plan.fixes.map((fix) => [fix.kind, fix.location, fix.result])).toEqual([
      ['evaluate_args', 'step 1', 'pre-approvable'],
      ['user_data_dir', 'options.user_data_dir', undefined],
    ]);
    expect(plan.manual).toEqual([
      {
        kind: 'evaluate_args',
        location: 'step 2',
        reason: expect.stringMatching(/carries a credential/u),
      },
    ]);
    expect(plan.caveat).toBe(ARGS_SUGGESTION_CAVEAT);
    // Untouched text survives byte for byte, the big integer included.
    expect(plan.fixed_text).toContain('"context": { "limit": 12345678901234567890 },');
    expect(plan.fixed_text).toContain(
      `        "script": "(a) => String(a.target).split(' | ')[0]",\n        "args": { "target": "{{target}}" },\n        "export_as": "first"`
    );
    expect(plan.fixed_text).toContain(`"user_data_dir": "${PROFILES}/portal"`);
    expect(plan.profile_move).toEqual({
      from: 'active/shared/runtime/browser/portal',
      to: `${PROFILES}/portal`,
    });
    expect(plan.diff[0]).toBe(`--- a/${SCOPE.input_path}`);
    expect(
      plan.diff.filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    ).toHaveLength(3);
  });

  it('fixes a native pipeline: nested evaluate, out-of-partition and default write paths', () => {
    const plan = planPipelineFix({ sourceText: NATIVE_TEXT, scope: SCOPE });
    expect(plan.format).toBe('browser_native');
    expect(plan.refusal).toBeUndefined();
    expect(plan.fixes.map((fix) => [fix.location, fix.kind, fix.after, fix.result])).toEqual([
      ['step 1.pipeline.0', 'evaluate_args', 'page function + args { row }', 'pre-approvable'],
      ['step 2', 'write_path', `${SCRATCH}/done.png`, 'pre-approvable'],
      ['step 3', 'write_path', `${SCRATCH}/fix-native-playwright.spec.ts`, 'pre-approvable'],
      ['options.user_data_dir', 'user_data_dir', `${PROFILES}/flow`, undefined],
    ]);
    expect(plan.before.per_step.map((entry) => entry.reason).sort()).toEqual([
      'templated_script',
      'write_path_unconfined',
      'write_path_unconfined',
    ]);
    expect(plan.after.per_step).toEqual([]);
    expect(plan.after.browser_profile).toBe(`${PROFILES}/flow`);
    expect(plan.before.browser_profile).toBe(`${PROFILES}/session-fix-native`);
    expect(plan.fixed_text).toContain(
      `"params": { "path": "${SCRATCH}/fix-native-playwright.spec.ts" }`
    );
  });

  it('leaves a write path manual when another value references the file', () => {
    const text = NATIVE_TEXT.replace(
      '{ "type": "capture", "op": "export_playwright", "params": {} }',
      '{ "type": "apply", "op": "log", "params": { "message": "saved evidence/screens/done.png" } }'
    );
    const plan = planPipelineFix({ sourceText: text, scope: SCOPE });
    expect(plan.manual).toEqual([
      {
        kind: 'write_path',
        location: 'step 2',
        reason: expect.stringMatching(/also referenced at steps\[3\]\.params\.message/u),
      },
    ]);
  });

  it('refuses a document with duplicate keys and leaves an already-confined file alone', () => {
    expect(() =>
      planPipelineFix({
        sourceText: ADF_TEXT.replace(
          '"pipeline_id": "fix-adf",',
          '"pipeline_id": "a", "pipeline_id": "b",'
        ),
        scope: SCOPE,
      })
    ).toThrow(/\[PIPELINE_FIX_DUPLICATE_KEYS\]/u);
    const clean = planPipelineFix({
      sourceText: `{ "pipeline_id": "ok", "steps": [{ "op": "browser:goto", "params": { "url": "https://a.example.test/" } }] }`,
      scope: SCOPE,
    });
    expect(clean.edits).toEqual([]);
    expect(clean.fixed_text).toContain('"pipeline_id": "ok"');
  });

  it('refuses an other-tenant profile move and a templated profile', () => {
    const other = planPipelineFix({
      sourceText: ADF_TEXT.replace(
        'active/shared/runtime/browser/portal',
        'active/shared/runtime/browser/profiles/confidential/other/portal'
      ),
      scope: SCOPE,
    });
    expect(other.profile_move?.refused).toMatch(/another run partition/u);
    const templated = planPipelineFix({
      sourceText: ADF_TEXT.replace('active/shared/runtime/browser/portal', '{{profile_dir}}'),
      scope: SCOPE,
    });
    expect(templated.manual.map((item) => item.reason)).toContain('it is templated');
  });

  it('moves only from this partition or a named legacy folder (allowlist, case-folded)', () => {
    const moveFrom = (dir: string) =>
      planPipelineFix({
        sourceText: ADF_TEXT.replace('active/shared/runtime/browser/portal', dir),
        scope: SCOPE,
      }).profile_move;
    // A partition or tier root, with no trailing slash.
    expect(moveFrom('active/shared/tmp/confidential/other')?.refused).toMatch(/partition/u);
    expect(moveFrom('active/shared/tmp/confidential/acme')?.refused).toMatch(/partition root/u);
    expect(moveFrom('active/shared/tmp/personal')?.refused).toMatch(/partition/u);
    expect(moveFrom('active/shared/tmp/confidential')?.refused).toMatch(/partition/u);
    // Case variants name the same directory on a case-insensitive disk.
    expect(
      moveFrom('active/shared/runtime/browser/Profiles/confidential/other/x')?.refused
    ).toMatch(/another run partition/u);
    expect(moveFrom('active/shared/tmp/CONFIDENTIAL/other/x')?.refused).toMatch(/partition/u);
    expect(moveFrom('Active/Shared/TMP/confidential/other/x')?.refused).toMatch(/partition/u);
    // Shared unpartitioned folders other runs use.
    expect(moveFrom('active/shared/tmp/browser')?.refused).toMatch(/is shared/u);
    // Allowed: this file's own scratch partition and a named legacy folder.
    expect(moveFrom('active/shared/tmp/confidential/acme/portal-profile')?.refused).toBeUndefined();
    expect(moveFrom('active/shared/tmp/portal-profile')?.refused).toBeUndefined();
  });

  it('sends an evaluate step that already has args to manual instead of throwing', () => {
    const text = ADF_TEXT.replace(
      `"script": "(() => '{{target}}'.split(' | ')[0])()",`,
      `"script": "(() => '{{target}}'.split(' | ')[0])()",\n        "args": { "x": 1 },`
    );
    expect(text).not.toBe(ADF_TEXT);
    const plan = planPipelineFix({ sourceText: text, scope: SCOPE });
    expect(plan.manual.map((item) => item.reason)).toContain(
      'the step already has args — merge the templated values into them by hand'
    );
  });
});
