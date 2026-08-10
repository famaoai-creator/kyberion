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
import { safeWriteFile, safeMkdir, safeExec } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core';

/**
 * Rendering a deck is far slower than the 30s safeExec default — a large HTML
 * report can take minutes through deck_from_html + pptx_render.
 */
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;

function main(): void {
  const [input, outArg] = process.argv.slice(2);
  if (!input) {
    console.error('usage: convert.ts <input.html> [output.pptx]');
    process.exit(1);
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
  // AGENTS.md §1: process execution goes through secure-io, never
  // node:child_process directly. safeExec captures output rather than
  // inheriting the terminal, so relay it to keep the CLI as legible as before —
  // especially on failure, where the pipeline's own diagnostics are the whole
  // reason to look at this command.
  try {
    const output = safeExec('node', ['dist/scripts/run_pipeline.js', '--input', pipePath], {
      cwd: pathResolver.rootDir(),
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    if (output.trim()) console.error(output.trimEnd());
  } catch (error: unknown) {
    const detail = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = detail?.stdout?.toString().trimEnd();
    const stderr = detail?.stderr?.toString().trimEnd();
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
    console.error(
      `[html-to-pptx] pipeline failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
    return;
  }
  console.error(`[html-to-pptx] wrote ${out}`);
}

main();
