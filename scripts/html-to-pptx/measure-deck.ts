/**
 * measure-deck CLI — 昇格済み op `media:deck_from_geometry` の薄いラッパ。
 *
 * 変換ロジックの正本は media-actuator
 * （`libs/actuators/media-actuator/src/deck-geometry-helpers.ts`、op `deck_from_geometry`
 * と `deck_measurement_script`）。このCLIは同じ関数を呼ぶだけなので、
 * コマンドラインとパイプラインで実装が一つになる。
 *
 * `deck_from_html` との違い: あちらは HTML を読んで自前で再レイアウトし、行数を
 * 文字数から推定する。こちらは**ブラウザに組ませて確定した幾何を転写する**ので、
 * 列幅・折返し位置がレポート HTML と一致する。
 *
 * なぜ CLI がブラウザを直接呼ぶか: トップレベルの `browser:` ステップは1件ずつ
 * 別セッションにラップされるため、`goto` と `evaluate` を別ステップに書くと
 * ページを共有できない。計測は1回の browser アクション内で行う必要がある。
 *
 * Run:
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/html-to-pptx/measure-deck.ts \
 *     <report.html> <out.json> [--aspect 4:3|16:9] [--viewport 1000] [--port 7401]
 */
import http from 'node:http';
import path from 'node:path';
import { safeExistsSync, safeMkdir, safeReadFile } from '@agent/core/secure-io';
import { writeJson } from '@agent/core/foundation/json';
import { t } from '@agent/core/t';
import { handleAction } from '../../libs/actuators/browser-actuator/src/index.js';
import {
  buildDeckMeasurementScript,
  geometryToDeckProtocol,
} from '../../libs/actuators/media-actuator/src/deck-geometry-helpers.js';
import { defineScript, isDirectScript } from '../lib/harness.js';

const USAGE = 'usage: measure-deck.ts <report.html> <out.json> [--aspect 4:3] [--port 7401]';

export async function main(argv: string[] = []): Promise<void> {
  const pos = argv.filter((a) => !a.startsWith('--'));
  const flag = (name: string, dflt: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const [inputHtml, outJson] = pos;
  if (!inputHtml || !outJson) {
    throw new Error(USAGE);
  }
  if (!safeExistsSync(inputHtml)) throw new Error(`not found: ${inputHtml}`);

  const ASPECT = flag('aspect', '4:3');
  const PORT = Number(flag('port', '7401'));
  const SLIDE = ASPECT === '16:9' ? { w: 13.333, h: 7.5 } : { w: 10, h: 7.5 };
  /** 計測 viewport 幅(px)。狭いほど 1px あたりのインチが大きく＝文字が大きく転写される。 */
  const VIEW_W = Number(flag('viewport', '1000'));

  // ── 127.0.0.1 の一時静的配信（このプロセス内に閉じる）
  const html = safeReadFile(inputHtml, { encoding: 'utf8' }) as string;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));

  /**
   * ページ内で走らせる計測スクリプト。
   * deck 用スタイルを流し込んでから、背景を持つ箱とテキストの葉ノードを実測する。
   */
  const SCRIPT = buildDeckMeasurementScript({
    aspect: ASPECT as '4:3' | '16:9',
    viewportPx: VIEW_W,
  });

  const res = (await handleAction({
    action: 'pipeline',
    session_id: 'measure-deck',
    steps: [
      { type: 'apply', op: 'goto', params: { url: `http://127.0.0.1:${PORT}/` } },
      { type: 'capture', op: 'evaluate', params: { script: SCRIPT, export_as: 'geom' } },
    ],
    options: {
      headless: true,
      browser_channel: 'chrome',
      navigation_policy: { allow_private_network: true },
    },
  } as never)) as { status?: string; context?: Record<string, unknown> };
  server.close();

  const geom = res.context?.geom as
    | {
        boxes: Array<Record<string, unknown>>;
        texts: Array<Record<string, unknown>>;
        cuts: number[];
        pageH: number;
      }
    | undefined;
  if (!geom) throw new Error(`measurement failed (status=${res.status})`);

  // ── 転写は op と同じ純関数に委譲する（実装をCLI側に持たない）
  const { protocol, slideCount } = geometryToDeckProtocol(geom as never, {
    aspect: ASPECT as '4:3' | '16:9',
    viewportPx: VIEW_W,
  });

  safeMkdir(path.dirname(outJson), { recursive: true });
  writeJson(outJson, protocol);
  console.log(
    t('media_tooling_measure_summary', {
      input: path.basename(inputHtml),
      out: outJson,
      boxes: geom.boxes.length,
      texts: geom.texts.length,
      pageH: geom.pageH,
      slides: slideCount,
      aspect: ASPECT,
      ppi: (VIEW_W / SLIDE.w).toFixed(0),
    })
  );
}

const script = defineScript({
  name: 'media:measure-deck',
  flags: [],
  run: ({ argv }) => main(argv),
});
if (
  isDirectScript(import.meta.url, 'measure-deck.ts') ||
  isDirectScript(import.meta.url, 'measure-deck.js')
) {
  void script();
}
