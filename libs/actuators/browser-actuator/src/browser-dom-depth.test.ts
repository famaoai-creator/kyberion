import { describe, expect, it, vi } from 'vitest';
import type { Frame, Page } from '@playwright/test';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import type { BrowserSnapshotElement } from './browser-runtime-helpers.js';
import { distillDomStructure } from './browser-pipeline-helpers.js';
import {
  RecordedRefSpoofSuspectedError,
  resolveRecordedRefSelector,
} from './recorded-ref-resolver.js';

function harvestElement(overrides: Partial<BrowserSnapshotElement>): BrowserSnapshotElement {
  return {
    ref: '@e1',
    tag: 'button',
    role: 'button',
    text: 'Go',
    name: 'Go',
    type: null,
    placeholder: null,
    href: null,
    value: null,
    visible: true,
    editable: false,
    selector: 'button',
    ...overrides,
  };
}

/**
 * A Frame double: `evaluate` branches on the harvest arg (number => in-page
 * harvest result; object with `innerSelector` => dom_path corroboration).
 */
function fakeFrame(options: {
  url?: string;
  name?: string;
  parent?: Frame | null;
  frameElementSelector?: string;
  harvest?: unknown;
  evaluateError?: boolean;
  corroborate?: (domPath: string, innerSelector: string) => boolean;
}): Frame {
  const frame = {
    parentFrame: () => options.parent ?? null,
    frameElement: async () => ({
      evaluate: async () => options.frameElementSelector ?? 'iframe:nth-of-type(1)',
    }),
    url: () => options.url ?? 'https://frame.example/',
    name: () => options.name ?? 'f1',
    evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (options.evaluateError) throw new Error('frame detached');
      if (typeof arg === 'number') return options.harvest ?? { elements: [] };
      if (arg && typeof arg === 'object' && 'innerSelector' in (arg as Record<string, unknown>)) {
        const { domPath, innerSelector } = arg as { domPath: string; innerSelector: string };
        return options.corroborate?.(domPath, innerSelector) ?? false;
      }
      return undefined;
    }),
  } as unknown as Frame;
  return frame;
}

function fakePage(options: {
  harvest?: unknown;
  frames?: Frame[];
  title?: string;
  url?: string;
}): Page & { main: Frame } {
  const main = {
    evaluate: async (_fn: unknown, _arg?: unknown) =>
      options.harvest ?? { viewport: undefined, ready_state: undefined, elements: [] },
    parentFrame: () => null,
  } as unknown as Frame;
  // Direct children report the main frame as their parent (Playwright
  // semantics — null is only ever returned for the main frame itself).
  for (const frame of options.frames ?? []) {
    if (!frame.parentFrame()) {
      (frame as { parentFrame: () => Frame | null }).parentFrame = () => main;
    }
  }
  return Object.assign(
    {
      mainFrame: () => main,
      frames: () => [main, ...(options.frames ?? [])],
      url: () => options.url ?? 'https://example.com/',
      title: async () => options.title ?? 'Example',
    },
    { main }
  ) as unknown as Page & { main: Frame };
}

describe('captureSnapshotElements frame traversal', () => {
  it('merges child-frame elements with enter-frame selector chains and frame metadata', async () => {
    const child = fakeFrame({
      url: 'https://pay.example/widget',
      name: 'pay',
      frameElementSelector: 'iframe#pay-frame',
      harvest: {
        total_candidates: 1,
        elements: [harvestElement({ name: 'Pay now', selector: 'button#pay' })],
      },
    });
    const page = fakePage({
      harvest: {
        viewport: { width: 800, height: 600, scale: 1 },
        ready_state: 'complete',
        total_candidates: 1,
        elements: [harvestElement({ name: 'Main', selector: 'button#main' })],
      },
      frames: [child],
    });

    const snapshot = await browserRuntimeHelpers.buildSnapshot(page as Page, {
      sessionId: 's1',
      tabId: 't1',
      maxElements: 50,
    });

    expect(snapshot.elements).toHaveLength(2);
    expect(snapshot.elements[0].ref).toBe('@e1');
    expect(snapshot.elements[0].selector).toBe('button#main');
    const framed = snapshot.elements[1];
    expect(framed.ref).toBe('@e2');
    expect(framed.selector).toBe('iframe#pay-frame >> internal:control=enter-frame >> button#pay');
    expect(framed.inner_selector).toBe('button#pay');
    expect(framed.frame).toEqual({ url: 'https://pay.example/widget', name: 'pay', depth: 1 });
    expect(snapshot.frame_count).toBe(1);
    expect(snapshot.element_total).toBe(2);
  });

  it('chains through nested frames recursively', async () => {
    const middle = fakeFrame({
      url: 'https://mid.example/',
      name: 'mid',
      frameElementSelector: 'iframe#mid',
      harvest: { total_candidates: 0, elements: [] },
    });
    const innerFramed = fakeFrame({
      url: 'https://deep.example/',
      name: 'deep',
      parent: middle,
      frameElementSelector: 'iframe#deep',
      harvest: { total_candidates: 1, elements: [harvestElement({ selector: 'input#x' })] },
    });
    const page = fakePage({
      harvest: { elements: [] },
      frames: [middle, innerFramed],
    });

    const snapshot = await browserRuntimeHelpers.buildSnapshot(page as Page, {
      sessionId: 's1',
      tabId: 't1',
      maxElements: 50,
    });

    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0].selector).toBe(
      'iframe#mid >> internal:control=enter-frame >> ' +
        'iframe#deep >> internal:control=enter-frame >> input#x'
    );
    expect(snapshot.elements[0].frame?.depth).toBe(2);
  });

  it('counts a failed frame harvest as frame_errors without losing other elements', async () => {
    const broken = fakeFrame({ evaluateError: true });
    const page = fakePage({
      harvest: { elements: [harvestElement({ selector: 'button#main' })] },
      frames: [broken],
    });
    const snapshot = await browserRuntimeHelpers.buildSnapshot(page as Page, {
      sessionId: 's1',
      tabId: 't1',
      maxElements: 50,
    });
    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.frame_errors).toBe(1);
  });

  it('carries occlusion fields through the snapshot when the harvest reports them', async () => {
    const page = fakePage({
      harvest: {
        elements: [
          harvestElement({ selector: 'button#a', occluded: false }),
          harvestElement({
            selector: 'button#b',
            occluded: true,
            occluded_by: 'div#overlay',
          }),
        ],
      },
    });
    const snapshot = await browserRuntimeHelpers.buildSnapshot(page as Page, {
      sessionId: 's1',
      tabId: 't1',
      maxElements: 50,
    });
    expect(snapshot.elements[0].occluded).toBe(false);
    expect(snapshot.elements[1].occluded).toBe(true);
    expect(snapshot.elements[1].occluded_by).toBe('div#overlay');
  });
});

describe('distillDomStructure', () => {
  it('returns a structure envelope distinct from the interactive inventory', async () => {
    const page = fakePage({
      harvest: {
        total_candidates: 2,
        elements: [
          {
            selector: 'main',
            tag: 'main',
            role: 'main',
            text: 'Hello world',
            depth: 1,
            child_count: 3,
            visible: true,
          },
        ],
      },
    });
    const out = await distillDomStructure(page as Page, { maxElements: 10 });
    expect(out.mode).toBe('structure');
    expect(out.total_candidates).toBe(2);
    expect(out.truncated).toBe(true);
    expect(out.elements[0]).toMatchObject({ tag: 'main', depth: 1, child_count: 3 });
  });

  it('stamps frame rows with frame metadata and frame-piercing selectors', async () => {
    const child = fakeFrame({
      url: 'https://ads.example/',
      name: 'ad',
      frameElementSelector: 'iframe#ad',
      harvest: {
        total_candidates: 1,
        elements: [
          {
            selector: 'nav',
            tag: 'nav',
            role: 'navigation',
            text: 'Menu',
            depth: 1,
            child_count: 4,
            visible: true,
          },
        ],
      },
    });
    const page = fakePage({ harvest: { total_candidates: 0, elements: [] }, frames: [child] });
    const out = await distillDomStructure(page as Page, {});
    expect(out.elements).toHaveLength(1);
    expect(out.elements[0].selector).toBe('iframe#ad >> internal:control=enter-frame >> nav');
    expect(out.elements[0].frame).toEqual({
      url: 'https://ads.example/',
      name: 'ad',
      depth: 1,
    });
    expect(out.frame_count).toBe(1);
  });
});

describe('recorded-ref frame corroboration', () => {
  const frameElement = harvestElement({
    role: 'button',
    name: 'Pay now',
    selector: 'iframe#pay >> internal:control=enter-frame >> button#pay',
    inner_selector: 'button#pay',
    frame: { url: 'https://pay.example/', name: 'pay', depth: 1 },
  });

  function framedPage(corroborate: boolean, frames: Frame[] = []) {
    const child =
      frames[0] ??
      fakeFrame({
        url: 'https://pay.example/',
        name: 'pay',
        corroborate: () => corroborate,
      });
    const page = {
      evaluate: vi.fn(async () => ({ elements: [frameElement] })),
      mainFrame: () => ({
        evaluate: async () => ({ elements: [frameElement] }),
      }),
      frames: () => [child],
    } as unknown as Page;
    return page;
  }

  it('corroborates dom_path inside the element frame via inner_selector', async () => {
    const page = framedPage(true);
    const result = await resolveRecordedRefSelector(page, {
      role: 'button',
      name: 'Pay now',
      dom_path: 'button#pay',
    });
    expect(result.selector).toBe('iframe#pay >> internal:control=enter-frame >> button#pay');
    expect(result.strategy).toBe('role_name');
  });

  it('fails closed with spoof suspicion when in-frame corroboration rejects', async () => {
    const page = framedPage(false);
    await expect(
      resolveRecordedRefSelector(page, {
        role: 'button',
        name: 'Pay now',
        dom_path: 'button#pay',
      })
    ).rejects.toBeInstanceOf(RecordedRefSpoofSuspectedError);
  });

  it('fails closed when the captured frame no longer exists on the page', async () => {
    const page = framedPage(true, [fakeFrame({ url: 'https://other.example/', name: 'other' })]);
    await expect(
      resolveRecordedRefSelector(page, {
        role: 'button',
        name: 'Pay now',
        dom_path: 'button#pay',
      })
    ).rejects.toBeInstanceOf(RecordedRefSpoofSuspectedError);
  });
});
