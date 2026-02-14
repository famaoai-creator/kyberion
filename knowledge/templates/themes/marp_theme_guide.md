# Marp テーマ作成 ＆ スタイリング完全ガイド

Marpit フレームワークを用いた高度なスライドデザインのためのリファレンス。

## 1. カスタムテーマの基本構造 (Theme CSS)

Marp のテーマは標準的な CSS ファイルです。`section` 要素がスライド1枚に対応します。

```css
/* @theme my-custom-theme */

section {
  width: 1280px;
  height: 720px;
  font-size: 30px;
  padding: 40px;
  background-color: #ffffff;
}

/* スライドタイトル */
h1 {
  font-size: 60px;
  color: #0d1b2a;
}
```

## 2. ディレクティブ (Directives)

Markdown の Front-matter または HTML コメントで指定します。

### Global (全体適用)

- `theme`: 使用するテーマ名。
- `headingDivider`: 指定した見出しレベル（例: 2）で自動的に改ページする。
- `style`: テーマ CSS を部分的に上書きする。

### Local (ページ適用)

- `paginate: true`: ページ番号を表示。
- `header`: ヘッダーテキストを指定。
- `footer`: フッターテキストを指定。
- `class`: スライド (`<section>`) に特定の CSS クラスを付与（例: `lead`, `invert`）。
- `_class`: **そのページだけに** クラスを適用（Spot Directive）。

## 3. 画像構文 (Extended Image Syntax)

背景画像の設定に特化した拡張構文があります。

- **背景設定**: `![bg](image.jpg)`
- **サイズ調整**: `![bg cover](image.jpg)` (全体), `![bg contain](image.jpg)` (収める)
- **配置**: `![bg right:40%](image.jpg)` (右側に40%幅で配置し、左側にテキスト領域を確保)
- **フィルタ**: `![bg brightness:0.8](image.jpg)` (明るさ調整)

## 4. 高度なテクニック

### ページ番号のスタイリング

```css
section::after {
  content: attr(data-marpit-pagination) ' / ' attr(data-marpit-pagination-total);
  position: absolute;
  bottom: 20px;
  right: 20px;
}
```

### スコープ付きスタイル

特定の要素やスライドだけに CSS を適用する場合、`<style scoped>` を使用します。

```html
<style scoped>
  h1 {
    color: red;
  }
</style>
```
