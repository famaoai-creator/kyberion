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
