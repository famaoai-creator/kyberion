import { handleAction, closeBrowserSession } from '../libs/actuators/browser-actuator/src/index.js';
import { createAjv } from '@agent/core/foundation';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import { pathResolver } from '@agent/core/path-resolver';
import { safeWriteFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type Step = { type: 'capture' | 'apply' | 'control'; op: string; params: Record<string, unknown> };
type Observation = { ref: string; selector?: string; text?: string; value?: string; name?: string };
type CaseResult = { pattern: string; passed: boolean; evidence?: unknown; error?: string };
const dataPage = (html: string) => `data:text/html,${encodeURIComponent(html)}`;
const page = dataPage(`<html><head><title>Actuator pattern probe</title></head><body>
<h1>Actuator pattern probe</h1><div id="fields"><label for="name">Name</label>
<input id="name" onkeydown="if(event.key==='Enter')document.querySelector('#result').textContent='Entered: '+this.value"></div>
<button id="greet" onclick="document.querySelector('#result').textContent='Hello, '+document.querySelector('#name').value">Greet</button>
<p id="result" role="status">Waiting</p>
<button class="ambiguous" onclick="document.querySelector('#result').textContent='FIRST'">Duplicate</button>
<button class="ambiguous" onclick="document.querySelector('#result').textContent='SECOND'">Duplicate</button>
<button id="delayed" onclick="setTimeout(()=>document.querySelector('#ready').hidden=false,100)">Show later</button><p id="ready" role="status" hidden>Ready</p>
<button id="rerender" onclick="document.querySelector('#fields').innerHTML='<label for=newname>New Name</label><input id=newname>'">Replace input</button>
</body></html>`);

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Real browser interactions through the governed actuator, never direct Playwright. */
export async function runBrowserUsabilityProbe() {
  const sessionId = `actuator-patterns-${process.pid}`;
  const root = pathResolver.sharedTmp(`browser-usability/${sessionId}`);
  const report: CaseResult[] = [];
  const validate = compileSchemaFromPath(
    createAjv(),
    pathResolver.knowledge('product/schemas/browser-automation-pipeline.schema.json')
  );
  async function run(steps: Step[], context: Record<string, unknown> = {}) {
    const input = {
      action: 'pipeline' as const,
      session_id: sessionId,
      options: { headless: true, keep_alive: true },
      steps,
      context,
    };
    // The schema owns domain-local names; validate normalized aliases before dispatch.
    const canonical = {
      ...input,
      steps: steps.map((step) => ({ ...step, op: step.op.replace(/^browser:/u, '') })),
    };
    requireCondition(
      validate(canonical),
      `Probe contract invalid: ${JSON.stringify(validate.errors)}`
    );
    return handleAction(input);
  }
  const step = (type: Step['type'], op: string, params: Record<string, unknown> = {}): Step => ({
    type,
    op,
    params: { max_retries: 0, ...params },
  });
  const snapshot = () => run([step('capture', 'browser:snapshot')]);
  const observations = (result: Awaited<ReturnType<typeof handleAction>>): Observation[] =>
    result.context?.last_snapshot?.elements || [];
  async function ref(selector: string) {
    const result = await snapshot();
    requireCondition(result.status === 'succeeded', 'Snapshot failed');
    const match = observations(result).find((entry) => entry.selector === selector);
    requireCondition(match, `No observed target for ${selector}`);
    return match.ref;
  }
  async function check(pattern: string, test: () => Promise<unknown>) {
    try {
      report.push({ pattern, passed: true, evidence: await test() });
    } catch (error) {
      report.push({
        pattern,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    await check('namespaced-open-snapshot', async () => {
      const result = await run([
        step('control', 'browser:open_tab', { url: page, tab_id: 'main' }),
        step('capture', 'browser:snapshot'),
      ]);
      requireCondition(
        result.status === 'succeeded' && result.title === 'Actuator pattern probe',
        'Namespaced open/snapshot failed'
      );
      return { title: result.title, elements: observations(result).length };
    });
    await check('unicode-fill-click-outcome', async () => {
      const inputRef = await ref('input#name');
      const buttonRef = await ref('button#greet');
      const text = '日本語 😀 "quoted"';
      const result = await run([
        step('apply', 'browser:fill_ref', { ref: inputRef, text }),
        step('apply', 'browser:click_ref', { ref: buttonRef }),
        step('capture', 'browser:snapshot'),
      ]);
      const status = observations(result).find((entry) => entry.selector === 'p#result')?.text;
      requireCondition(
        result.status === 'succeeded' && status === `Hello, ${text}`,
        'Unicode outcome differs from input'
      );
      return { status };
    });
    await check('missing-fill-value-rejected', async () => {
      const inputRef = await ref('input#name');
      const before = observations(await snapshot()).find(
        (entry) => entry.selector === 'input#name'
      )?.value;
      const failed = await run([step('apply', 'browser:fill_ref', { ref: inputRef })]);
      const after = observations(await snapshot()).find(
        (entry) => entry.selector === 'input#name'
      )?.value;
      requireCondition(
        failed.status === 'failed' && before === after,
        'Missing fill value cleared input'
      );
      return { error: failed.results?.[0]?.error, unchanged: true };
    });
    await check('nullable-template-fill-rejected', async () => {
      const inputRef = await ref('input#name');
      const before = observations(await snapshot()).find(
        (entry) => entry.selector === 'input#name'
      )?.value;
      const failed = await run(
        [step('apply', 'browser:fill_ref', { ref: inputRef, text: '{{value}}' })],
        { value: null }
      );
      const after = observations(await snapshot()).find(
        (entry) => entry.selector === 'input#name'
      )?.value;
      requireCondition(
        failed.status === 'failed' && before === after,
        'Nullable template cleared input'
      );
      return { error: failed.results?.[0]?.error, unchanged: true };
    });
    await check('explicit-empty-fill', async () => {
      const inputRef = await ref('input#name');
      const result = await run([
        step('apply', 'browser:fill_ref', { ref: inputRef, text: '' }),
        step('capture', 'browser:snapshot'),
      ]);
      requireCondition(
        result.status === 'succeeded' &&
          observations(result).find((entry) => entry.selector === 'input#name')?.value === '',
        'Explicit clear failed'
      );
      return { value: '' };
    });
    await check('keyboard-enter', async () => {
      const inputRef = await ref('input#name');
      const result = await run([
        step('apply', 'browser:press_ref', { ref: inputRef, key: 'Enter' }),
        step('capture', 'browser:snapshot'),
      ]);
      const status = observations(result).find((entry) => entry.selector === 'p#result')?.text;
      requireCondition(
        result.status === 'succeeded' && status?.startsWith('Entered:'),
        'Enter did not update status'
      );
      return { status };
    });
    await check('ambiguous-selector-rejected', async () => {
      const before = observations(await snapshot()).find(
        (entry) => entry.selector === 'p#result'
      )?.text;
      const result = await run([
        step('apply', 'browser:click', { selector: '.ambiguous', timeout: 300 }),
      ]);
      requireCondition(result.status === 'failed', 'Ambiguous selector silently clicked a target');
      const after = observations(await snapshot()).find(
        (entry) => entry.selector === 'p#result'
      )?.text;
      requireCondition(before === after, 'Ambiguous selector mutated the page before failing');
      return { error: result.results?.[0]?.error, unchanged: true };
    });
    await check('explicit-first-match', async () => {
      const result = await run([
        step('apply', 'browser:click_first_match', { selector: '.ambiguous' }),
        step('capture', 'browser:snapshot'),
      ]);
      requireCondition(
        result.status === 'succeeded' &&
          observations(result).some((entry) => entry.text === 'FIRST'),
        'Explicit first match failed'
      );
      return { status: 'FIRST' };
    });
    await check('first-match-missing-rejected', async () => {
      const result = await run([
        step('apply', 'browser:click_first_match', { selector: '#does-not-exist' }),
      ]);
      requireCondition(result.status === 'failed', 'Missing first-match target reported success');
      return { error: result.results?.[0]?.error };
    });
    await check('delayed-element-wait', async () => {
      const result = await run([
        step('apply', 'browser:click', { selector: '#delayed' }),
        step('apply', 'browser:wait', { selector: '#ready', state: 'visible', timeout: 1500 }),
        step('capture', 'browser:snapshot'),
      ]);
      requireCondition(
        result.status === 'succeeded' &&
          observations(result).some((entry) => entry.text === 'Ready'),
        'Delayed element not observed'
      );
      return { ready: true };
    });
    await check('timeout-and-recovery', async () => {
      const failed = await run([
        step('apply', 'browser:wait', { selector: '#missing', state: 'visible', timeout: 100 }),
      ]);
      requireCondition(failed.status === 'failed', 'Missing-element wait did not fail');
      const recovered = await snapshot();
      requireCondition(recovered.status === 'succeeded', 'Session did not recover after timeout');
      return { error: failed.results?.[0]?.error, recovered: true };
    });
    await check('rerender-reobserve-fill', async () => {
      await run([step('apply', 'browser:click', { selector: '#rerender' })]);
      const newRef = await ref('input#newname');
      const result = await run([
        step('apply', 'browser:fill_ref', { ref: newRef, text: 'Fresh target' }),
        step('capture', 'browser:snapshot'),
      ]);
      requireCondition(
        result.status === 'succeeded' &&
          observations(result).some((entry) => entry.value === 'Fresh target'),
        'Reobserved target fill failed'
      );
      return { value: 'Fresh target' };
    });
    await check('unknown-ref-and-recovery', async () => {
      const failed = await run([
        step('apply', 'browser:click_ref', { ref: '@missing', timeout: 100 }),
      ]);
      requireCondition(
        failed.status === 'failed' && String(failed.results?.[0]?.error).includes('snapshot'),
        'Ref error lacks recovery guidance'
      );
      requireCondition((await snapshot()).status === 'succeeded', 'Reobservation failed');
      return { recovered: true };
    });
    await check('navigation-and-tab-switch', async () => {
      const result = await run([
        step('capture', 'browser:goto', {
          url: dataPage('<title>Navigated</title><h1>Navigation complete</h1>'),
        }),
        step('control', 'browser:open_tab', {
          url: dataPage('<title>Second</title><h1>Second tab</h1>'),
          tab_id: 'second',
        }),
        step('control', 'browser:select_tab', { tab_id: 'main' }),
        step('capture', 'browser:snapshot'),
      ]);
      requireCondition(
        result.status === 'succeeded' && result.title === 'Navigated',
        'Tab selection lost page context'
      );
      return { title: result.title, active_tab: result.context.active_tab_id };
    });
    await check('unknown-tab-and-recovery', async () => {
      requireCondition(
        (await run([step('control', 'browser:select_tab', { tab_id: 'absent' })])).status ===
          'failed',
        'Unknown tab selection succeeded'
      );
      const result = await run([
        step('control', 'browser:select_tab', { tab_id: 'second' }),
        step('capture', 'browser:snapshot'),
        step('capture', 'browser:screenshot', { path: `${root}/final.png` }),
      ]);
      requireCondition(
        result.status === 'succeeded' && result.title === 'Second',
        'Tab recovery failed'
      );
      return { title: result.title, screenshot: `${root}/final.png` };
    });
  } finally {
    await closeBrowserSession(sessionId);
  }
  const result = {
    ok: report.every((entry) => entry.passed),
    patterns: report,
    report_path: `${root}/report.json`,
  };
  safeWriteFile(result.report_path, JSON.stringify(result, null, 2), { mkdir: true });
  return result;
}

const script = defineScript({
  name: 'browser-actuator-usability-probe',
  run: async ({ print }) => {
    const result = await runBrowserUsabilityProbe();
    print(result);
    if (!result.ok)
      throw new ScriptExitError(1, 'Browser usability patterns failed; inspect report_path');
    return result;
  },
});
if (
  isDirectScript(import.meta.url, 'browser_actuator_usability_probe.ts') ||
  isDirectScript(import.meta.url, 'browser_actuator_usability_probe.js')
)
  void script();
