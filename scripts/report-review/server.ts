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
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import {
  portableProtocolServicePathRef,
  recordProtocolServiceLifecycle,
} from '@agent/core/protocol-service-lifecycle';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { createReportReviewContext, reviewReceiptLogicalPath } from './context.js';
import { reviewLayerMarkup, RV_LAYER_OPEN, RV_LAYER_CLOSE } from './review-layer.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

export interface ReportReviewServerResult {
  ok: boolean;
  mode: 'apply' | 'dry-run' | 'check';
  target: string;
  port: number;
  url: string;
  artifact_ref: string;
  scope: ReturnType<typeof createReportReviewContext>['scope'];
  listening: boolean;
}

async function main(
  args: string[] = [],
  options: {
    dryRun?: boolean;
    check?: boolean;
    json?: boolean;
    print?: (value: unknown) => void;
  } = {}
): Promise<ReportReviewServerResult | undefined> {
  const target = args[0];
  const positionalPort = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  const option = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const port = Number(positionalPort || 8137);
  if (!target) {
    throw new ScriptExitError(
      1,
      'usage: server <report.html> [port] [--artifact-ref <ref>] [--tier <tier>] [--tenant <slug>]'
    );
  }
  assertProtocolServiceRegistered('report-review');
  if (!safeExistsSync(target)) {
    throw new ScriptExitError(1, `report not found: ${target}`);
  }

  const tier = (option('--tier') || 'public') as 'public' | 'confidential' | 'personal';
  if (!['public', 'confidential', 'personal'].includes(tier)) {
    throw new ScriptExitError(1, `invalid tier: ${tier}`);
  }
  const reviewContext = createReportReviewContext({
    artifact_ref: option('--artifact-ref') || target,
    viewer_principal:
      getRegisteredEnvText('KYBERION_VIEWER_PRINCIPAL') ||
      getRegisteredEnvText('KYBERION_MCP_PRINCIPAL') ||
      'local-reviewer',
    tier,
    tenant_slug: option('--tenant') || getRegisteredEnvText('KYBERION_TENANT'),
    organization_id: option('--organization-id'),
    project_id: option('--project-id'),
    mission_id: option('--mission-id'),
  });
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ScriptExitError(1, `invalid port: ${port}`);

  const mode = options.check ? 'check' : options.dryRun ? 'dry-run' : 'apply';
  const url = `http://127.0.0.1:${port}/`;
  const preview: ReportReviewServerResult = {
    ok: true,
    mode,
    target,
    port,
    url,
    artifact_ref: reviewContext.artifact_ref,
    scope: reviewContext.scope,
    listening: false,
  };
  const print = options.print ?? console.log;
  if (options.dryRun || options.check) {
    if (options.json || options.dryRun || options.check) print(preview);
    else print(`${mode}: would serve ${target} at ${url}`);
    return preview;
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
  const ts = () => nowIso().replace(/[:.]/g, '').slice(0, 15);

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
            safeWriteFile(
              reviewReceiptLogicalPath(reviewContext),
              JSON.stringify(
                {
                  review_session_id: reviewContext.review_session_id,
                  artifact_ref: portableProtocolServicePathRef(reviewContext.artifact_ref),
                  viewer_principal: reviewContext.viewer_principal,
                  scope: reviewContext.scope,
                  saved_at: nowIso(),
                  bytes: html.length,
                  backup: backup.split('/').pop(),
                  comment_count: (html.match(/class=["']rv-cmt["']/g) || []).length,
                },
                null,
                2
              ),
              { mkdir: true, encoding: 'utf8' }
            );
            res.writeHead(200);
            res.end(
              `saved (backup: ${backup.split('/').pop()}, review_session: ${reviewContext.review_session_id})`
            );
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
    try {
      recordProtocolServiceLifecycle({
        serviceId: 'report-review',
        action: 'start',
        status: 'started',
        scope: reviewContext.scope,
        actorRole: 'surface_runtime',
        principal: { kind: 'human', id: reviewContext.viewer_principal },
        requestedBy: reviewContext.viewer_principal,
        correlationId: reviewContext.review_session_id,
        metadata: {
          port,
          artifact_ref: portableProtocolServicePathRef(reviewContext.artifact_ref),
        },
      });
    } catch (error) {
      console.error(`[report-review] start lifecycle receipt unavailable: ${error}`);
      server.close(() => {
        process.exitCode = 1;
      });
      return;
    }
    if (options.json) {
      print({ ...preview, listening: true });
    } else {
      print(`Report review server → ${url}`);
      print(`  target : ${target}`);
      print(`  artifact: ${reviewContext.artifact_ref}`);
      print(
        `  scope  : ${reviewContext.scope.scope_kind}/${reviewContext.scope.tenant_slug || 'system'}`
      );
      print(`  token  : ${TOKEN.slice(0, 6)}…  (127.0.0.1 only, backups: <file>.bak-<ts>)`);
      print('  Open the URL, review (✏️/💬/🎤), then 💾 to save back. Ctrl-C to stop.');
    }
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    try {
      recordProtocolServiceLifecycle({
        serviceId: 'report-review',
        action: 'stop',
        status: 'stopped',
        scope: reviewContext.scope,
        actorRole: 'surface_runtime',
        principal: { kind: 'human', id: reviewContext.viewer_principal },
        requestedBy: reviewContext.viewer_principal,
        correlationId: reviewContext.review_session_id,
      });
    } catch (error) {
      console.error(`[report-review] stop lifecycle receipt unavailable: ${error}`);
    } finally {
      server.close();
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...preview, listening: true };
}

export const runReportReviewServer = defineScript({
  name: 'report-review:server',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, print }) => main(argv, { dryRun, check, json, print }),
});

if (isDirectScript(import.meta.url, 'server.ts') || isDirectScript(import.meta.url, 'server.js'))
  void runReportReviewServer();
