/**
 * html-to-pptx CLI — thin convenience wrapper around the promoted ADF ops
 * `media:deck_from_html` → `media:pptx_render`.
 *
 * The conversion logic is now canonical in the media-actuator
 * (`libs/actuators/media-actuator/src/html-deck-helpers.ts`, op `deck_from_html`).
 * This CLI just assembles the two-step pipeline and runs it, so command-line use
 * and pipeline use share one implementation.
 *
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/html-to-pptx/convert.ts \\
 *     <input.html> [output.pptx] [--aspect 4:3|16:9] [--strict]
 *
 * `--strict` は収まりの検査（pptx_layout_preflight）で溢れが出たら出力せず失敗させる。
 * 既定は検査結果を表示するだけで出力する（既存の使い方を壊さないため）。
 *
 * Or use the ops directly in any pipeline:
 *   { "op": "media:deck_from_html", "params": { "path": "report.html" } }   // -> last_pptx_design
 *   { "op": "media:pptx_render", "consumes": "last_pptx_design", "params": { "path": "out.pptx" } }
 */
import { safeWriteFile, safeMkdir } from '@agent/core/secure-io';
import { executePipelineFile } from '../run_pipeline.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { cliOptionValue, cliPositionals, hasCliFlag } from '../lib/cli-guard.js';

type Print = (value: unknown) => void;

async function main(argv: string[], print: Print = () => undefined): Promise<void> {
  const aspect = cliOptionValue(argv, '--aspect') ?? '';
  const strict = hasCliFlag(argv, '--strict');
  const positional = cliPositionals(argv, ['--aspect']);
  const [input, outArg] = positional;
  if (!input) {
    throw new ScriptExitError(
      1,
      'usage: convert.ts <input.html> [output.pptx] [--aspect 4:3|16:9] [--strict]'
    );
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
            params: { path: input, ...(aspect ? { aspect } : {}) },
          },
          {
            // 収まりの実測。溢れたスライドを出力前に可視化する。
            // --strict でない限り診断を出して先へ進む（既存の使い方を壊さない）。
            id: 'preflight',
            role: 'transform',
            op: 'media:pptx_layout_preflight',
            produces: { channel: 'media_layout_diagnostics', type: 'LayoutDiagnostics' },
            params: { from: 'last_pptx_design', allow_layout_overflow: !strict },
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
  const result = await executePipelineFile(pipePath, {
    quiet: true,
    // The converter creates this pipeline itself and owns the operator
    // request that executes it; do not leave the trust decision implicit.
    trustResolved: true,
  });
  if (result.status === 'failed') {
    throw new Error(
      `pipeline failed: ${result.results.find((entry) => entry.status === 'failed')?.error || 'unknown error'}`
    );
  }
  print(`[html-to-pptx] wrote ${out}`);
}

const script = defineScript({
  name: 'media:html-to-pptx',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'convert.ts') ||
  isDirectScript(import.meta.url, 'convert.js')
) {
  void script();
}
