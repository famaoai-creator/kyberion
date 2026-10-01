import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

/**
 * IT-04 ratchet: artifact engines read colours through semantic design tokens
 * (so tenant overlays reach them). Raw hex literals are only allowed in the
 * single last-resort fallback module.
 */
const GUARDED = [
  'libs/actuators/media-actuator/src/media-spreadsheet-pipeline-helpers.ts',
  'libs/core/video/video-design-system.ts',
  'libs/actuators/media-actuator/src/media-layout-runtime.ts',
  'libs/actuators/media-actuator/src/html-deck-helpers.ts',
  'libs/core/media/native-pptx-engine/layout-primitives.ts',
  'libs/actuators/media-actuator/src/media-diagram-render-helpers.ts',
  'libs/actuators/media-actuator/src/media-report-docx-builder.ts',
];
const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*\d/;

describe('semantic design token ratchet', () => {
  for (const rel of GUARDED) {
    it(`${rel} has no raw colour literals`, () => {
      const lines = (
        safeReadFile(pathResolver.rootResolve(rel), { encoding: 'utf8' }) as string
      ).split('\n');
      const offenders = lines
        .map((text, i) => ({ text, line: i + 1 }))
        .filter(({ text }) => HEX.test(text) && !/^\s*(\/\/|\*|\/\*)/.test(text));
      expect(offenders).toEqual([]);
    });
  }
});
