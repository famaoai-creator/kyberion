import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { RV_LAYER_CLOSE, RV_LAYER_OPEN } from './review-layer.js';
import { main, planReportReviewStamp } from './stamp.js';

describe('report review stamp plan', () => {
  it('adds the review layer before the closing body tag', () => {
    const plan = planReportReviewStamp('<html><body><main>report</main></body></html>', false);

    expect(plan.action).toBe('add');
    expect(plan.changed).toBe(true);
    expect(plan.content).toContain(`${RV_LAYER_OPEN}`);
    expect(plan.content.indexOf(RV_LAYER_OPEN)).toBeLessThan(plan.content.indexOf('</body>'));
  });

  it('removes only a previously stamped layer', () => {
    const html = `<html><body>${RV_LAYER_OPEN}<div>layer</div>${RV_LAYER_CLOSE}</body></html>`;
    const plan = planReportReviewStamp(html, true);

    expect(plan).toEqual({
      action: 'remove',
      changed: true,
      content: '<html><body></body></html>',
    });
  });

  it('reports a no-op for an already embedded layer', () => {
    const html = '<html><body><div id="rv-bar">embedded</div></body></html>';

    expect(planReportReviewStamp(html, false)).toEqual({
      action: 'noop',
      changed: false,
      content: html,
    });
  });

  it('routes dry-run output through the injected printer', () => {
    const target = pathResolver.sharedTmp(`report-review-stamp-${process.pid}.html`);
    const output: unknown[] = [];
    safeWriteFile(target, '<html><body><main>report</main></body></html>');

    try {
      const result = main(['--dry-run', target], {
        dryRun: true,
        print: (value) => output.push(value),
      });

      expect(result).toMatchObject({ mode: 'dry-run', action: 'add', changed: true });
      expect(output).toHaveLength(1);
      expect(output[0]).toMatchObject({ mode: 'dry-run', action: 'add' });
    } finally {
      safeRmSync(target, { force: true });
    }
  });
});
