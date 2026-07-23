import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import type { BrowserSnapshotElement } from './browser-runtime-helpers.js';
import {
  RecordedRefAmbiguousError,
  RecordedRefSpoofSuspectedError,
  RecordedRefUnresolvedError,
  resolveRecordedRefSelector,
  resolveRefOrRecordedTarget,
} from './recorded-ref-resolver.js';

function element(overrides: Partial<BrowserSnapshotElement>): BrowserSnapshotElement {
  return {
    ref: '@e1',
    tag: 'div',
    role: null,
    text: '',
    name: '',
    type: null,
    placeholder: null,
    href: null,
    value: null,
    visible: true,
    editable: false,
    selector: 'div:nth-of-type(1)',
    ...overrides,
  };
}

function fakePage(
  elements: BrowserSnapshotElement[],
  domPathCount: (selector: string) => number = () => 0,
  domPathMatchesCandidate: (domPath: string, candidateSelector: string) => boolean = () => false
): Page {
  return {
    evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (typeof arg === 'string') return domPathCount(arg);
      if (arg && typeof arg === 'object' && 'domPath' in (arg as Record<string, unknown>)) {
        const { domPath, candidateSelector } = arg as {
          domPath: string;
          candidateSelector: string;
        };
        return domPathMatchesCandidate(domPath, candidateSelector);
      }
      return { viewport: undefined, ready_state: undefined, elements };
    }),
  } as unknown as Page;
}

describe('resolveRecordedRefSelector', () => {
  it('resolves via role+name when exactly one element matches', async () => {
    const page = fakePage([
      element({ tag: 'button', role: 'button', name: 'Submit', selector: 'button#submit' }),
      element({ tag: 'button', role: 'button', name: 'Cancel', selector: 'button#cancel' }),
    ]);
    const result = await resolveRecordedRefSelector(page, { role: 'button', name: 'Submit' });
    expect(result).toEqual({ selector: 'button#submit', strategy: 'role_name' });
  });

  it('resolves native elements with no explicit role attribute via the implicit-role table', async () => {
    const page = fakePage([
      element({ tag: 'button', role: null, name: 'Submit', selector: 'button:nth-of-type(1)' }),
    ]);
    const result = await resolveRecordedRefSelector(page, { role: 'button', name: 'Submit' });
    expect(result).toEqual({ selector: 'button:nth-of-type(1)', strategy: 'role_name' });
  });

  it('falls back to dom_path when no role/name match is found', async () => {
    const page = fakePage([], (selector) => (selector === '#legacy-widget' ? 1 : 0));
    const result = await resolveRecordedRefSelector(page, {
      role: 'button',
      name: 'Ghost',
      dom_path: '#legacy-widget',
    });
    expect(result).toEqual({ selector: '#legacy-widget', strategy: 'dom_path' });
  });

  it('throws RecordedRefUnresolvedError when nothing matches at all', async () => {
    const page = fakePage([]);
    await expect(
      resolveRecordedRefSelector(page, { role: 'button', name: 'Ghost' })
    ).rejects.toThrow(RecordedRefUnresolvedError);
  });

  it('throws RecordedRefAmbiguousError when more than one element matches role+name', async () => {
    const page = fakePage([
      element({ tag: 'button', role: 'button', name: 'Submit', selector: 'button#a' }),
      element({ tag: 'button', role: 'button', name: 'Submit', selector: 'button#b' }),
    ]);
    await expect(
      resolveRecordedRefSelector(page, { role: 'button', name: 'Submit' })
    ).rejects.toThrow(RecordedRefAmbiguousError);
  });

  it('throws RecordedRefAmbiguousError when dom_path matches more than one element', async () => {
    const page = fakePage([], (selector) => (selector === '.row' ? 3 : 0));
    await expect(
      resolveRecordedRefSelector(page, { role: 'button', name: 'Ghost', dom_path: '.row' })
    ).rejects.toThrow(RecordedRefAmbiguousError);
  });

  it('ignores invisible elements', async () => {
    const page = fakePage([
      element({ tag: 'button', role: 'button', name: 'Submit', visible: false }),
    ]);
    await expect(
      resolveRecordedRefSelector(page, { role: 'button', name: 'Submit' })
    ).rejects.toThrow(RecordedRefUnresolvedError);
  });

  it('resolves when dom_path corroborates the role/name match (same element)', async () => {
    const page = fakePage(
      [element({ tag: 'button', role: 'button', name: 'Submit', selector: 'button#submit' })],
      undefined,
      (domPath, candidateSelector) =>
        domPath === '#submit-btn' && candidateSelector === 'button#submit'
    );
    const result = await resolveRecordedRefSelector(page, {
      role: 'button',
      name: 'Submit',
      dom_path: '#submit-btn',
    });
    expect(result).toEqual({ selector: 'button#submit', strategy: 'role_name' });
  });

  it('throws RecordedRefSpoofSuspectedError when dom_path disagrees with the role/name match (relabeled element)', async () => {
    // Simulates a page that relabeled a DIFFERENT element with the recorded
    // role+name — role/name matching alone would silently click/fill the
    // wrong (potentially attacker-controlled) element.
    const page = fakePage(
      [element({ tag: 'button', role: 'button', name: 'Submit', selector: 'button#decoy' })],
      undefined,
      () => false
    );
    await expect(
      resolveRecordedRefSelector(page, {
        role: 'button',
        name: 'Submit',
        dom_path: '#original-submit-btn',
      })
    ).rejects.toThrow(RecordedRefSpoofSuspectedError);
  });

  it('fails closed when requireDomPathMatch is set but no dom_path was recorded (secret fill without corroboration)', async () => {
    const page = fakePage([
      element({ tag: 'input', role: 'textbox', name: 'API Key', selector: 'input#key' }),
    ]);
    await expect(
      resolveRecordedRefSelector(page, {
        role: 'textbox',
        name: 'API Key',
        requireDomPathMatch: true,
      })
    ).rejects.toThrow(RecordedRefSpoofSuspectedError);
  });

  it('succeeds when requireDomPathMatch is set and dom_path corroborates the match (secret fill, correctly wired)', async () => {
    const page = fakePage(
      [element({ tag: 'input', role: 'textbox', name: 'API Key', selector: 'input#key' })],
      undefined,
      (domPath, candidateSelector) => domPath === '#key-field' && candidateSelector === 'input#key'
    );
    const result = await resolveRecordedRefSelector(page, {
      role: 'textbox',
      name: 'API Key',
      dom_path: '#key-field',
      requireDomPathMatch: true,
    });
    expect(result).toEqual({ selector: 'input#key', strategy: 'role_name' });
  });
});

describe('resolveRefOrRecordedTarget', () => {
  it('uses ctx.ref_map when the ref is already known, without calling the resolver', async () => {
    const page = fakePage([]);
    const ctx = { ref_map: { '@e1': 'button#known' } };
    const result = await resolveRefOrRecordedTarget(ctx, '@e1', page, {
      role: 'button',
      name: 'Submit',
    });
    expect(result.selector).toBe('button#known');
    expect(result.ctx).toBe(ctx);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('falls back to the recorded target on a ref_map miss and caches the result', async () => {
    const page = fakePage([
      element({ tag: 'button', role: 'button', name: 'Submit', selector: 'button#submit' }),
    ]);
    const ctx = { ref_map: {} };
    const result = await resolveRefOrRecordedTarget(ctx, '@e9', page, {
      role: 'button',
      name: 'Submit',
    });
    expect(result.selector).toBe('button#submit');
    expect(result.ctx.ref_map).toEqual({ '@e9': 'button#submit' });
  });

  it('rethrows the original "Unknown browser ref" error when no recorded target is supplied', async () => {
    const page = fakePage([]);
    const ctx = { ref_map: {} };
    await expect(resolveRefOrRecordedTarget(ctx, '@e9', page)).rejects.toThrow(
      /Unknown browser ref/
    );
  });
});
