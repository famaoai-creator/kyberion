#!/usr/bin/env node
/**
 * scripts/bootstrap.cjs
 * 環境に依存せず、@agent/core への参照を確立するためのブートストラップスクリプト。
 * npm workspaces が機能しない場合でも、手動でシンボリックリンクを構築します。
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const targetDir = path.join(rootDir, 'node_modules', '@agent');
const coreSource = path.join(rootDir, 'scripts', 'lib');
const coreLink = path.join(targetDir, 'core');

console.log('[Bootstrap] Setting up @agent/core linkage...');

try {
  // node_modules/@agent ディレクトリの作成
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 既存のリンクやファイルがある場合は削除（再構築のため）
  if (fs.existsSync(coreLink)) {
    const stats = fs.lstatSync(coreLink);
    if (stats.isSymbolicLink() || stats.isFile()) {
      fs.unlinkSync(coreLink);
    } else if (stats.isDirectory()) {
      // ディレクトリの場合は中身を考慮して削除が必要だが、通常はリンクのはず
      fs.rmSync(coreLink, { recursive: true, force: true });
    }
  }

  // 相対パスでシンボリックリンクを作成
  const relativeSource = path.relative(targetDir, coreSource);
  fs.symlinkSync(relativeSource, coreLink, 'junction');

  console.log(`[Bootstrap] Success: @agent/core -> ${relativeSource}`);
} catch (err) {
  console.error(`[Bootstrap] Failed to create link: ${err.message}`);
  // リンク作成に失敗した場合のフォールバック策として、環境変数の活用などを検討可能
}
