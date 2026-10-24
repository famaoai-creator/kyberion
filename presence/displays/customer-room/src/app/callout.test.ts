/**
 * D2 (customer decision E2E): `.kb-callout` is a flex row; content appended
 * straight into it rendered every receipt / state card of the room as squeezed
 * vertical columns at 390 px. Callouts are built by createCallout, whose text
 * goes in the `.kb-callout__content` column.
 */
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import {
  FakeDocument,
  FakeElement,
} from '../../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { createCallout } from './callout.js';

describe('customer-room callout', () => {
  it('puts the content in a .kb-callout__content column inside the flex row', () => {
    const doc = new FakeDocument();
    const { box, content } = createCallout(
      doc as unknown as Document,
      'section',
      'cr-state',
      'success'
    );
    content.appendChild(doc.createElement('h1') as unknown as Node);
    content.appendChild(doc.createElement('p') as unknown as Node);

    const element = box as unknown as FakeElement;
    expect(element.className).toBe('kb-callout cr-state');
    expect(element.getAttribute('data-tone')).toBe('success');
    // The row has one child — the content column — which holds title and body.
    expect(element.childNodes).toHaveLength(1);
    const column = element.childNodes[0] as FakeElement;
    expect(column.className).toBe('kb-callout__content');
    expect(column.childNodes.map((node) => (node as FakeElement).localName)).toEqual(['h1', 'p']);
  });

  it('main.ts builds every callout (the error line too) through createCallout', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('presence/displays/customer-room/src/app/main.ts'),
      { encoding: 'utf8' }
    ) as string;
    // A block callout built by hand would append its title/body into the row.
    expect(source).not.toMatch(/el\(\s*'\w+',\s*'kb-callout\b/u);
    expect(source.match(/createCallout\(/gu)?.length ?? 0).toBeGreaterThanOrEqual(7);
  });
});
