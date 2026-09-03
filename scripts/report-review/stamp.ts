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
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

export interface ReportReviewStampPlan {
  action: 'add' | 'remove' | 'noop';
  changed: boolean;
  content: string;
}

export interface ReportReviewStampResult {
  ok: boolean;
  mode: 'apply' | 'dry-run' | 'check';
  target: string;
  action: ReportReviewStampPlan['action'];
  changed: boolean;
}

export function planReportReviewStamp(html: string, remove: boolean): ReportReviewStampPlan {
  const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (remove) {
    const content = html.replace(
      new RegExp(re(RV_LAYER_OPEN) + '[\\s\\S]*?' + re(RV_LAYER_CLOSE), 'g'),
      ''
    );
    return { action: content === html ? 'noop' : 'remove', changed: content !== html, content };
  }

  if (html.includes(RV_LAYER_OPEN) || /id="rv-bar"/.test(html))
    return { action: 'noop', changed: false, content: html };

  const layer = reviewLayerMarkup();
  const content = html.includes('</body>')
    ? html.replace('</body>', `${layer}\n</body>`)
    : html + layer;
  return { action: 'add', changed: true, content };
}

export function main(
  argv: string[] = [],
  options: {
    dryRun?: boolean;
    check?: boolean;
    json?: boolean;
    print?: (value: unknown) => void;
  } = {}
): ReportReviewStampResult {
  const target = argv.find((arg) => !arg.startsWith('--'));
  const remove = argv.includes('--remove');
  if (!target) throw new ScriptExitError(1, 'usage: stamp <report.html> [--remove]');
  if (!safeExistsSync(target)) throw new ScriptExitError(1, `report not found: ${target}`);

  const plan = planReportReviewStamp(safeReadFile(target, { encoding: 'utf8' }) as string, remove);
  const mode = options.check ? 'check' : options.dryRun ? 'dry-run' : 'apply';
  if (!options.check && !options.dryRun && plan.changed)
    safeWriteFile(target, plan.content, { mkdir: false, encoding: 'utf8' });

  const result: ReportReviewStampResult = {
    ok: !options.check || !plan.changed,
    mode,
    target,
    action: plan.action,
    changed: plan.changed,
  };
  const print = options.print ?? console.log;
  if (options.json || options.dryRun || options.check) print(result);
  else if (plan.action === 'remove') print(`removed review layer from ${target}`);
  else if (plan.action === 'add')
    print(
      `stamped review layer into ${target} (open with file:// for offline review; use --remove to strip)`
    );
  else if (remove) print('no review layer found (nothing removed)');
  else print('review layer already present — nothing to do');

  if (options.check && plan.changed) throw new ScriptExitError(1, '', true);
  return result;
}

export const runReportReviewStamp = defineScript({
  name: 'report-review:stamp',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, print }) => main(argv, { dryRun, check, json, print }),
});

if (isDirectScript(import.meta.url, 'stamp.ts') || isDirectScript(import.meta.url, 'stamp.js'))
  void runReportReviewStamp();
