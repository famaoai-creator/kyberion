import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SelectionSettings from '../src/components/SelectionSettings';
import type { SelectionSnapshot } from '../src/lib/selection-contract';

const snapshot: SelectionSnapshot = {
  revision: 'fixture',
  canEdit: false,
  rows: [
    {
      role: 'implementer',
      requested: {
        mode: 'fixed',
        agent_id: 'actor-one',
        provider: 'provider-one',
        model: 'model-one',
      },
      effective: { agent_id: 'actor-two', provider: 'provider-two', model: 'model-two' },
      source: 'fallback',
      reason: 'Cached reason',
      valid: true,
      fallback: true,
      choices: [],
    },
  ],
};
function render(canEdit = false, locale: 'en' | 'ja' = 'en') {
  return renderToStaticMarkup(
    createElement(SelectionSettings, {
      initial: { ...snapshot, canEdit },
      target: { kind: 'mission', missionId: 'MSN-FIXTURE' },
      locale,
    })
  );
}
describe('selection rendering contract', () => {
  it('shows requested/resolved/source/reason dimensions separately', () => {
    const html = render();
    for (const text of [
      'Requested',
      'Resolved choice',
      'Source',
      'Reason',
      'Agent identity:',
      'Provider:',
      'Model:',
      'actor-one',
      'actor-two',
      'Cached reason',
      'Fallback',
    ])
      expect(html).toContain(text);
  });
  it('shows current ineligibility without replacing the stored target or selection reason', () => {
    const html = renderToStaticMarkup(
      createElement(SelectionSettings, {
        initial: {
          ...snapshot,
          canEdit: true,
          rows: [
            {
              ...snapshot.rows[0],
              valid: false,
              eligibility: {
                eligible: false,
                reason: 'Provider unavailable. Choose an eligible agent before dispatch.',
              },
            },
          ],
        },
        target: { kind: 'mission', missionId: 'MSN-FIXTURE' },
        locale: 'en',
      })
    );
    expect(html).toContain('actor-two');
    expect(html).toContain('Cached reason');
    expect(html).toContain('Provider unavailable. Choose an eligible agent before dispatch.');
    expect(html).toContain('Blocked');
    const description = html.match(/<article[^>]*aria-describedby="([^"]+)"/)?.[1];
    expect(description).toBeTruthy();
    const references = description!.split(' ');
    expect(references.some((reference) => reference.endsWith('-current-reason'))).toBe(true);
    expect(references.some((reference) => reference.endsWith('-current-eligibility'))).toBe(true);
    for (const reference of references) expect(html).toContain('id="' + reference + '"');
    expect(html).toMatch(
      new RegExp('<button[^>]*aria-describedby="' + description + '"[^>]*>Edit</button>')
    );
  });
  it('keeps stable live-status and distinct per-role reason associations', () => {
    const html = renderToStaticMarkup(
      createElement(SelectionSettings, {
        initial: {
          ...snapshot,
          rows: [snapshot.rows[0], { ...snapshot.rows[0], role: 'reviewer' }],
        },
        target: { kind: 'mission', missionId: 'MSN-FIXTURE' },
        locale: 'en',
      })
    );
    expect(html).toMatch(/id="[^"]+-status" role="status" aria-live="polite" aria-atomic="true"/);
    const descriptions = [...html.matchAll(/<article[^>]*aria-describedby="([^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(descriptions).toHaveLength(2);
    expect(new Set(descriptions).size).toBe(2);
    for (const description of descriptions) expect(html).toContain('id="' + description + '"');
  });
  it('renders no edit controls for readonly users', () => {
    const html = render();
    expect(html).toContain('Read-only.');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
  });
  it('shows one accessible edit button only to writable viewers, in both locales', () => {
    expect(render(true)).toMatch(/<button[^>]*>Edit<\/button>/);
    expect(render(true, 'ja')).toContain('編集');
  });
  it('escapes registry-derived labels and reasons instead of interpreting markup', () => {
    const html = renderToStaticMarkup(
      createElement(SelectionSettings, {
        initial: {
          ...snapshot,
          rows: [{ ...snapshot.rows[0], reason: '<script>alert(1)</script>' }],
        },
        target: { kind: 'reasoning' },
        locale: 'en',
      })
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Saving does not restart');
  });
});
