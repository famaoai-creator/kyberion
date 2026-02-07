# プロフェッショナル・スライドテーマ作成ガイド (Marp/CSS)

このガイドでは、Geminiエージェントがビジネスシーンで高く評価されるスライドテーマを設計するためのベストプラクティスをまとめています。

## 1. 基本構造
Marpテーマは標準的なCSSで記述しますが、以下のメタデータとインポートが必須です。

```css
@theme custom-theme-name
@import 'default'; /* 基本スタイルを継承 */

section {
  width: 1280px;
  height: 720px;
  padding: 50px;
  font-family: 'Hiragino Sans', 'Meiryo', sans-serif;
  background-color: #f9f9f9;
}
```

## 2. ビジュアル・アイデンティティの注入
特定の企業やブランドに合わせる際は、以下の手法で「専用感」を出します。

- **ロゴの自動挿入**: `section::before` を使い、全スライドの右上に配置。
- **アクセントカラー**: 見出し（`h1`, `h2`）や強調（`strong`）にブランドカラーを適用。
- **タイトルスライドの差別化**: `section.lead` クラスを定義し、グラデーション背景や反転色を使用。

## 3. 高度なレイアウト設計
Markdownの制限を超え、情報を視覚的に整理するために以下のクラスを定義します。

### 2カラム・グリッド
```css
.columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 40px;
}
```

### 情報カード (Card)
重要なポイントを囲む枠。色を変えることで「ポジティブ/ネガティブ」を表現。
```css
.card {
  background: #fff;
  padding: 25px;
  border-radius: 15px;
  box-shadow: 0 10px 20px rgba(0,0,0,0.05);
  border-top: 5px solid var(--brand-color);
}
```

## 4. 視認性の最適化
- **余白 (Whitespace)**: `padding` を十分に（40-60px）取り、情報の密度を抑える。
- **文字サイズ**: 本文は最小でも 24px-28px を維持。
- **コントラスト**: 背景色と文字色の比率をWCAG基準に合わせて調整（`ux-auditor` との連携）。

## 5. プレゼン・ストーリーテリングとの連動
- **フッター**: `footer::after` を使い、全スライドに「Confidential」や「プロジェクト名」を表示。
- **1スライド・1メッセージ**: 複雑なCSSを使わずとも、適切な `h1` と `img` の配置で解決できる場合はそれを優先する。
