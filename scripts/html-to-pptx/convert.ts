/**
 * html-to-pptx CLI — thin convenience wrapper around the promoted ADF ops
 * `media:deck_from_html` → `media:pptx_render`.
 *
 * The conversion logic is now canonical in the media-actuator
 * (`libs/actuators/media-actuator/src/html-deck-helpers.ts`, op `deck_from_html`).
 * This CLI just assembles the two-step pipeline and runs it, so command-line use
 * and pipeline use share one implementation.
 *
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/html-to-pptx/convert.ts <input.html> [output.pptx]
 *
 * Or use the ops directly in any pipeline:
 *   { "op": "media:deck_from_html", "params": { "path": "report.html" } }   // -> last_pptx_design
 *   { "op": "media:pptx_render", "consumes": "last_pptx_design", "params": { "path": "out.pptx" } }
 */
import { safeWriteFile, safeMkdir } from '@agent/core/secure-io';
import { executePipelineFile } from '../run_pipeline.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

async function main(argv: string[]): Promise<void> {
  const [input, outArg] = argv;
  if (!input) {
    console.error('usage: convert.ts <input.html> [output.pptx]');
    throw new ScriptExitError(1, 'input HTML path is required');
  }
  const out = outArg || input.replace(/\.html?$/i, '.pptx');
  const tmp = 'active/shared/tmp/html-to-pptx';
  safeMkdir(tmp, { recursive: true });
  const pipePath = `${tmp}/render.pipeline.json`;
  safeWriteFile(
    pipePath,
    JSON.stringify(
      {
        id: 'html-to-pptx',
        version: '1.0.0',
        description: 'Convert report HTML to an editable PPTX via deck_from_html + pptx_render',
        steps: [
          {
            id: 'build',
            role: 'transform',
            op: 'media:deck_from_html',
            produces: { channel: 'last_pptx_design', type: 'PptxDesignProtocol' },
            params: { path: input },
          },
          {
            id: 'render',
            role: 'sink',
            op: 'media:pptx_render',
            consumes: 'last_pptx_design',
            params: { path: out },
          },
        ],
      },
      null,
      1
    ),
    { mkdir: true, encoding: 'utf8' }
  );
  const result = await executePipelineFile(pipePath, { quiet: true });
  if (result.status === 'failed') {
    throw new Error(
      `pipeline failed: ${result.results.find((entry) => entry.status === 'failed')?.error || 'unknown error'}`
    );
  }
  console.error(`[html-to-pptx] wrote ${out}`);
}

const script = defineScript({
  name: 'media:html-to-pptx',
  flags: [],
  run: ({ argv }) => main(argv),
});
if (
  isDirectScript(import.meta.url, 'convert.ts') ||
  isDirectScript(import.meta.url, 'convert.js')
) {
  void script();
}
