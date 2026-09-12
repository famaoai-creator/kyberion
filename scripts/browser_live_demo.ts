/**
 * Tiny live demo: open example.com → snapshot → click Learn more → screenshot.
 *
 * Usage:
 *   KYBERION_PERSONA=sovereign pnpm exec tsx scripts/browser_live_demo.ts
 */
import { handleAction, closeBrowserSession } from '../libs/actuators/browser-actuator/src/index.ts';
import { pathResolver } from '@agent/core/path-resolver';
import { defineScript, isDirectScript } from './lib/harness.js';

export async function runBrowserLiveDemo(): Promise<Record<string, unknown>> {
  const sessionId = `browser-live-demo-${process.pid}`;
  const before = pathResolver.sharedTmp(`browser-live/${sessionId}-before.png`);
  const after = pathResolver.sharedTmp(`browser-live/${sessionId}-after.png`);

  const result = await handleAction({
    action: 'pipeline',
    session_id: sessionId,
    options: { headless: true, keep_alive: true },
    steps: [
      { type: 'apply', op: 'navigate', params: { url: 'https://example.com' } },
      { type: 'capture', op: 'snapshot', params: {} },
      { type: 'capture', op: 'screenshot', params: { path: before } },
      { type: 'apply', op: 'click', params: { ref: '@e1' } },
      { type: 'capture', op: 'snapshot', params: {} },
      { type: 'capture', op: 'screenshot', params: { path: after } },
    ],
  } as any);

  await closeBrowserSession(sessionId);

  return {
    status: result.status,
    summary: result.summary ?? {
      url: result.url,
      title: result.title,
      element_count: result.element_count,
      refs: result.refs,
      screenshot: result.screenshot,
    },
    before,
    after,
    results: result.results,
  };
}

export const runBrowserLiveDemoScript = defineScript({
  name: 'browser-live-demo',
  flags: [],
  async run(context) {
    const report = await runBrowserLiveDemo();
    context.print(JSON.stringify(report, null, 2));
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'browser_live_demo.ts') ||
  isDirectScript(import.meta.url, 'browser_live_demo.js')
) {
  runBrowserLiveDemoScript();
}
