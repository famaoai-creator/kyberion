import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Structural accessibility guards for the Side Panel shell. These are the
// static guarantees the spec's §8 acceptance criteria depend on; dynamic
// controls (review/decision buttons, input fields) are labelled in sidepanel.js.
const html = readFileSync(
  path.resolve(__dirname, '../tools/adf-replay-extension/sidepanel.html'),
  'utf8'
);

describe('Browser Bridge side panel accessibility', () => {
  it('declares a document language', () => {
    expect(html).toMatch(/<html[^>]*\blang="ja"/);
  });

  it('labels the tab navigation and makes every tab a real button', () => {
    expect(html).toMatch(/<nav class="tabs"[^>]*aria-label=/);
    expect(html).toMatch(/role="tablist"[^>]*aria-label=/);
    const tabButtons = html.match(/<button\s+class="tab[^"]*"[^>]*>/g) || [];
    expect(tabButtons.length).toBe(7); // Intent, Live, 受信, 送信, Record, Review, Run
    expect(tabButtons.every((tag) => /type="button"/.test(tag))).toBe(true);
  });

  it('wires every tab to its tabpanel with ARIA and a single selected tab', () => {
    const tabButtons = html.match(/<button\s+class="tab[^"]*"[^>]*>/g) || [];
    expect(tabButtons.every((tag) => /role="tab"/.test(tag))).toBe(true);
    expect(tabButtons.filter((tag) => /aria-selected="true"/.test(tag))).toHaveLength(1);
    expect(tabButtons.filter((tag) => /tabindex="0"/.test(tag))).toHaveLength(1);
    for (const tag of tabButtons) {
      const tabId = tag.match(/\bid="([^"]+)"/)?.[1];
      const panelId = tag.match(/aria-controls="([^"]+)"/)?.[1];
      expect(tabId && panelId).toBeTruthy();
      const panel = new RegExp(
        `<section[^>]*id="${panelId}"[^>]*role="tabpanel"[^>]*aria-labelledby="${tabId}"`
      );
      expect(html).toMatch(panel);
    }
    expect(html).toMatch(/data-tab="inbox"[\s\S]*?受信/);
    expect(html).toMatch(/data-tab="send"[\s\S]*?送信/);
  });

  it('announces new inbox items through a polite status region', () => {
    expect(html).toMatch(/id="inbox-live"[^>]*role="status"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="send-result"[^>]*role="status"[^>]*aria-live="polite"/);
  });

  it('labels the inbox lists, the auto-answer toggle and the send form', () => {
    expect(html).toMatch(/id="inbox-requests"[^>]*aria-labelledby="inbox-requests-heading"/);
    expect(html).toMatch(/id="inbox-approvals"[^>]*aria-labelledby="inbox-approvals-heading"/);
    expect(html).toMatch(
      /<label class="toggle-row">\s*<input id="local-infer-auto-toggle" type="checkbox" \/>\s*<span\s*>ローカル推論依頼を自動応答/
    );
    expect(html).not.toMatch(/id="local-infer-auto-toggle"[^>]*checked/);
    expect(html).toMatch(/<fieldset class="send-fieldset">\s*<legend>送信方法<\/legend>/);
    expect(html).toMatch(/<fieldset class="send-fieldset">\s*<legend>保存先の区分<\/legend>/);
    expect(html).toMatch(/name="send-tier" value="personal" checked/);
    expect(html).toMatch(/id="send-preview"[^>]*aria-label=/);
    expect(html).toMatch(/id="webmcp-tools"[^>]*aria-label="このページが公開している AI ツール"/);
  });

  it('has no approve control in the inbox', () => {
    const inbox = html.slice(html.indexOf('id="panel-inbox"'), html.indexOf('id="panel-send"'));
    expect(inbox).not.toMatch(/<button[^>]*>\s*(承認する|Approve)/);
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

  it('loads the shared redaction boundary before AI and panel logic', () => {
    const pii = html.indexOf('src="pii-rules.generated.js"');
    const ai = html.indexOf('src="built-in-ai.js"');
    const panel = html.indexOf('src="sidepanel.js"');
    expect(pii).toBeGreaterThan(-1);
    expect(ai).toBeGreaterThan(pii);
    expect(panel).toBeGreaterThan(ai);
    const inbox = html.indexOf('src="bridge-inbox.js"');
    expect(inbox).toBeGreaterThan(pii);
    expect(panel).toBeGreaterThan(inbox);
    expect(html).toMatch(/id="ai-scenario-use-intent-button"/);
  });
});
