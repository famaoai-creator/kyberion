import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutcomeFilesFocus } from '../lib/outcome-files-focus';
/** DOM doubles only: browser focus behavior and React commit timing are not exercised. */
function element() {
  const node = {
    isConnected: true,
    focus: vi.fn(),
    contains: vi.fn((target: unknown) => target === node),
    querySelector: vi.fn(),
  };
  return node;
}
describe('outcome pagination/retry focus ownership (DOM doubles)', () => {
  let source: ReturnType<typeof element>,
    added: ReturnType<typeof element>,
    panel: ReturnType<typeof element>,
    alert: ReturnType<typeof element>,
    body: ReturnType<typeof element>;
  let doc: { activeElement: unknown; body: unknown; hasFocus: ReturnType<typeof vi.fn> };
  let focus: ReturnType<typeof createOutcomeFilesFocus>;
  const owner = {},
    done = { open: true, busy: false, error: false };
  const html = (value: unknown) => value as HTMLElement;
  beforeEach(() => {
    source = element();
    added = element();
    panel = element();
    alert = element();
    body = element();
    panel.querySelector.mockReturnValue(added);
    doc = { activeElement: source, body, hasFocus: vi.fn(() => true) };
    focus = createOutcomeFilesFocus(
      () => doc as Pick<Document, 'activeElement' | 'body' | 'hasFocus'>
    );
  });
  it('focuses the first appended link or unavailable status only after completion', () => {
    focus.begin(owner, html(source), 10);
    focus.complete(owner, { ...done, busy: true }, html(panel), html(alert));
    expect(added.focus).not.toHaveBeenCalled();
    focus.complete(owner, done, html(panel), html(alert));
    expect(panel.querySelector).toHaveBeenCalledWith(
      '[data-outcome-file-index="10"] a, [data-outcome-file-index="10"] [tabindex="-1"]'
    );
    expect(added.focus).toHaveBeenCalledOnce();
    focus.complete(owner, done, html(panel), html(alert));
    expect(added.focus).toHaveBeenCalledOnce();
  });
  it.each([0, 10])('handles a removed Retry or last-page control at index %s', (index) => {
    focus.begin(owner, html(source), index);
    source.isConnected = false;
    doc.activeElement = body;
    focus.moved(body as unknown as EventTarget);
    focus.complete(owner, done, html(panel), html(alert));
    expect(added.focus).toHaveBeenCalledOnce();
  });
  it('focuses the error panel after failed pagination', () => {
    focus.begin(owner, html(source), 10);
    source.isConnected = false;
    doc.activeElement = body;
    focus.complete(owner, { ...done, error: true }, html(panel), html(alert));
    expect(alert.focus).toHaveBeenCalledOnce();
    expect(added.focus).not.toHaveBeenCalled();
  });
  it.each([
    'focus moved',
    'pointer elsewhere',
    'close',
    'refresh',
    'blur',
    'unfocused document',
    'unfocused trigger',
  ])('does not steal focus after %s', (reason) => {
    if (reason === 'unfocused trigger') doc.activeElement = body;
    focus.begin(owner, html(source), 10);
    if (reason === 'focus moved') {
      doc.activeElement = body;
      focus.moved(body as unknown as EventTarget);
    }
    if (reason === 'pointer elsewhere') focus.pointed(body as unknown as Node);
    if (reason === 'blur') focus.cancel();
    if (reason === 'unfocused document') doc.hasFocus.mockReturnValue(false);
    focus.complete(
      reason === 'refresh' ? {} : owner,
      { ...done, open: reason !== 'close' },
      html(panel),
      html(alert)
    );
    expect(added.focus).not.toHaveBeenCalled();
    expect(panel.focus).not.toHaveBeenCalled();
    expect(alert.focus).not.toHaveBeenCalled();
  });
  it('falls back to the focusable list status', () => {
    focus.begin(owner, html(source), 0);
    panel.querySelector.mockReturnValue(null);
    focus.complete(owner, done, html(panel), html(alert));
    expect(panel.focus).toHaveBeenCalledOnce();
  });
});
