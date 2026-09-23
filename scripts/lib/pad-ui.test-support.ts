// Test helper: parse the `#pad-bootstrap` JSON that `renderPadPage` embeds.
import { expect } from 'vitest';

export interface PadBootstrapForTest {
  locale: string;
  language?: string;
  messages: Record<string, string>;
  texts: Record<string, string>;
  [key: string]: unknown;
}

export function padBootstrapOf(html: string): PadBootstrapForTest {
  const match = /<script type="application\/json" id="pad-bootstrap">([\s\S]*?)<\/script>/u.exec(
    html
  );
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as PadBootstrapForTest;
}

/** The markup outside `<script>…</script>` blocks (visible-text assertions only). */
export function withoutScriptBlocks(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let index = 0;
  for (;;) {
    const start = lower.indexOf('<script', index);
    if (start < 0) return out + html.slice(index);
    out += html.slice(index, start);
    const end = lower.indexOf('</script', start);
    if (end < 0) return out;
    const close = lower.indexOf('>', end);
    index = close < 0 ? html.length : close + 1;
  }
}
