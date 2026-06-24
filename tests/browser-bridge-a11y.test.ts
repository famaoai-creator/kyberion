import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Structural accessibility guards for the Side Panel shell. These are the
// static guarantees the spec's §8 acceptance criteria depend on; dynamic
// controls (review/decision buttons, input fields) are labelled in sidepanel.js.
const html = readFileSync(
  path.resolve(__dirname, '../tools/adf-replay-extension/sidepanel.html'),
  'utf8',
);

describe('Browser Bridge side panel accessibility', () => {
  it('declares a document language', () => {
    expect(html).toMatch(/<html[^>]*\blang="ja"/);
  });

  it('labels the tab navigation and makes every tab a real button', () => {
    expect(html).toMatch(/<nav class="tabs"[^>]*aria-label=/);
    const tabButtons = html.match(/<button class="tab[^"]*"[^>]*>/g) || [];
    expect(tabButtons.length).toBe(5); // Intent, Live, Record, Review, Run
    expect(tabButtons.every((tag) => /type="button"/.test(tag))).toBe(true);
  });

  it('exposes status changes through live regions', () => {
    expect(html).toMatch(/id="notice"[^>]*aria-live="polite"/);
    expect(html).toMatch(/class="recording-summary"[^>]*aria-live="polite"/);
  });

  it('names the raw draft preview region for assistive tech', () => {
    expect(html).toMatch(/id="draft-preview"[^>]*aria-label=/);
  });

  it('keeps execution input values out of the recorded draft via a dedicated form region', () => {
    expect(html).toMatch(/id="execution-inputs"/);
    expect(html).toMatch(/INPUT VALUES \(記録されません\)/);
  });
});
