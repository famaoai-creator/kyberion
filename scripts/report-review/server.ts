/**
 * server.ts — レポートレビュー・サーバ（汎用 / 方式B: ローカル直書き保存）
 *
 * 任意のHTMLレポートを 127.0.0.1 で配信し、配信時にレビューレイヤ（review-layer.ts）を
 * オーバーレイ注入する。ブラウザで編集/コメント/音声入力し、💾でファイルへ直書き保存する。
 *
 * 使い方:
 *   KYBERION_PERSONA=sovereign node_modules/.bin/tsx scripts/report-review/server.ts <report.html> [port]
 *   → http://127.0.0.1:<port>/ を開く（localhost=セキュアコンテキスト＝🎤マイク可）。Ctrl-C で停止。
 *
 * 安全策:
 *   - 127.0.0.1 限定・保存先は起動時の1ファイルに固定（POSTでパス指定不可）。
 *   - 起動ごとのランダムトークン＋Origin検査（他ローカルページからのCSRF防止）。
 *   - 書込前にタイムスタンプ付きバックアップ。
 *   - 配信時に注入したレイヤ/保存configは保存時に除去し、正本HTMLを汚さない（オーバーレイ方式）。
 *     既にレイヤが焼き込まれている(id="rv-bar"検出)レポートには再注入しない。
 *   - ファイルI/Oは @agent/core/secure-io 経由（confidential階層への書込は適切な PERSONA が必要）。
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { safeReadFile, safeWriteFile, safeExistsSync } from '@agent/core/secure-io';
import { reviewLayerMarkup, RV_LAYER_OPEN, RV_LAYER_CLOSE } from './review-layer.js';

const target = process.argv[2];
const port = Number(process.argv[3] || 8137);
if (!target) {
  console.error('usage: server <report.html> [port]');
  process.exit(1);
}
if (!safeExistsSync(target)) {
  console.error(`report not found: ${target}`);
  process.exit(1);
}

const TOKEN = randomBytes(16).toString('hex');
const CFG_OPEN = '<!--RV-SAVE-CONFIG-->';
const CFG_CLOSE = '<!--/RV-SAVE-CONFIG-->';
const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripBetween = (html: string, o: string, c: string) =>
  html.replace(new RegExp(re(o) + '[\\s\\S]*?' + re(c), 'g'), '');

function stripInjected(html: string): string {
  return stripBetween(stripBetween(html, CFG_OPEN, CFG_CLOSE), RV_LAYER_OPEN, RV_LAYER_CLOSE);
}
function serveHtml(): string {
  let html = stripInjected(safeReadFile(target, { encoding: 'utf8' }) as string);
  const cfg = `${CFG_OPEN}<script>window.__RV_SAVE__={url:'/save',token:'${TOKEN}'};</script>${CFG_CLOSE}`;
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${cfg}`)
    : cfg + html;
  // レイヤが未焼き込みの場合のみ、配信時にオーバーレイ注入する
  if (!/id="rv-bar"/.test(html)) {
    const layer = reviewLayerMarkup();
    html = html.includes('</body>') ? html.replace('</body>', `${layer}\n</body>`) : html + layer;
  }
  return html;
}
const ts = () => new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);

const server = http.createServer((req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(serveHtml());
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/save') {
      if (req.headers['x-rv-token'] !== TOKEN) {
        res.writeHead(403);
        res.end('bad token');
        return;
      }
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)) {
        res.writeHead(403);
        res.end('bad origin');
        return;
      }
      let data = '';
      let aborted = false;
      req.on('data', (c) => {
        data += c;
        if (data.length > 25 * 1024 * 1024) {
          aborted = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          const html = stripInjected(data);
          if (!/<\/html>\s*$/i.test(html.trim())) {
            res.writeHead(400);
            res.end('not a complete HTML document');
            return;
          }
          const backup = `${target}.bak-${ts()}`;
          safeWriteFile(backup, safeReadFile(target, { encoding: 'utf8' }) as string, {
            mkdir: true,
            encoding: 'utf8',
          });
          safeWriteFile(target, html, { mkdir: false, encoding: 'utf8' });
          res.writeHead(200);
          res.end(`saved (backup: ${backup.split('/').pop()})`);
          console.log(
            `[save] wrote ${target} (backup ${backup.split('/').pop()}, ${html.length} bytes)`
          );
        } catch (e: unknown) {
          res.writeHead(500);
          res.end(e instanceof Error ? e.message : String(e));
          console.error('[save]', e);
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e: unknown) {
    res.writeHead(500);
    res.end(e instanceof Error ? e.message : String(e));
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Report review server → http://127.0.0.1:${port}/`);
  console.log(`  target : ${target}`);
  console.log(`  token  : ${TOKEN.slice(0, 6)}…  (127.0.0.1 only, backups: <file>.bak-<ts>)`);
  console.log('  Open the URL, review (✏️/💬/🎤), then 💾 to save back. Ctrl-C to stop.');
});
