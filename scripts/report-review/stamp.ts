/**
 * stamp.ts — レビューレイヤをHTMLファイルへ「焼き込む / 剥がす」CLI（方式A: オフライン用）
 *
 * サーバを使わず file:// で開いて編集・コメント・音声・エクスポートしたい場合に、
 * レビューレイヤをファイル本体へ恒久的に埋め込む。剥がすことも可能。
 *
 * 使い方:
 *   node_modules/.bin/tsx scripts/report-review/stamp.ts <report.html>            # 焼き込む（既に有れば何もしない）
 *   node_modules/.bin/tsx scripts/report-review/stamp.ts <report.html> --remove   # 剥がす
 *
 * 注意: file:// では 🎤(Web Speech) はマイク制限で使えないことが多い（OSディクテーションは可）。
 *       サーバ経由(server.ts)なら localhost=セキュアコンテキストで 🎤 も使える。
 *       confidential階層への書込は適切な PERSONA が必要。
 */
import { safeReadFile, safeWriteFile, safeExistsSync } from '@agent/core/secure-io';
import { reviewLayerMarkup, RV_LAYER_OPEN, RV_LAYER_CLOSE } from './review-layer.js';

const target = process.argv[2];
const remove = process.argv.includes('--remove');
if (!target) {
  console.error('usage: stamp <report.html> [--remove]');
  process.exit(1);
}
if (!safeExistsSync(target)) {
  console.error(`report not found: ${target}`);
  process.exit(1);
}

const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let html = safeReadFile(target, { encoding: 'utf8' }) as string;

if (remove) {
  const before = html.length;
  html = html.replace(new RegExp(re(RV_LAYER_OPEN) + '[\\s\\S]*?' + re(RV_LAYER_CLOSE), 'g'), '');
  safeWriteFile(target, html, { mkdir: false, encoding: 'utf8' });
  console.log(
    before === html.length
      ? 'no review layer found (nothing removed)'
      : `removed review layer from ${target}`
  );
} else {
  if (html.includes(RV_LAYER_OPEN) || /id="rv-bar"/.test(html)) {
    console.log('review layer already present — nothing to do');
  } else {
    const layer = reviewLayerMarkup();
    html = html.includes('</body>') ? html.replace('</body>', `${layer}\n</body>`) : html + layer;
    safeWriteFile(target, html, { mkdir: false, encoding: 'utf8' });
    console.log(
      `stamped review layer into ${target} (open with file:// for offline review; use --remove to strip)`
    );
  }
}
