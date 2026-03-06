---
title: Software Supply Chain Governance & SBOM Standards
category: Security
tags: [security, supply, chain, governance]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Software Supply Chain Governance & SBOM Standards

このドキュメントは、ソフトウェアサプライチェーンの透明性と安全性を確保するための、現代的な管理手法とノウハウをまとめたものである。

## 1. SBOM (Software Bill of Materials) の役割

SBOM は「ソフトウェアの部品表」であり、製品に含まれる全てのオープンソース、ライブラリ、依存関係をリスト化したものである。

### 主要なフォーマット
- **CycloneDX**: OWASPが主導する、軽量で自動化に適したフォーマット。Vulnerability (VEX) 情報の紐付けに強い。
- **SPDX (Software Package Data Exchange)**: Linux Foundationが主導する、ISO標準 (ISO/IEC 5962:2021)。ライセンス管理に強い。

### 活用のメリット
- **脆弱性管理の迅速化**: CVE（共通脆弱性識別子）が発表された際、影響を受ける製品を数秒で特定できる。
- **ライセンス・コンプライアンス**: 知的財産権のリスクを回避する。
- **透明性の向上**: 顧客や政府（例：米大統領令14028号）への報告義務に対応する。

## 2. 攻撃ベクトルと防御策

### Dependency Confusion (依存関係の混乱)
- **内容**: 公開リポジトリ（npm等）に、社内用ライブラリと同じ名前で高バージョンの悪意あるパッケージを公開し、自動ビルド時に誤って取り込ませる。
- **防御**: スコープ（例：`@company/`）の使用、`.npmrc` でのレジストリ固定、ロックファイルの厳格な管理。

### Typosquatting (タイポスクワッティング)
- **内容**: 有名なパッケージ名（例：`lodash`）に似た名前（例：`lowdash`）で偽パッケージを公開する。
- **防御**: AIによる名前の類似性検知、パッケージのダウンロード数やメンテナンス履歴の自動チェック。

## 3. SLSA (Supply-chain Levels for Software Artifacts)

Googleが提唱した、ビルドプロセスの完全性を保証するためのフレームワーク。

- **Level 1**: ビルドプロセスのドキュメント化。
- **Level 2**: ホストされたビルドサービスの使用、署名付き来歴（Provenance）の生成。
- **Level 3**: 隔離されたビルド環境（Ephemeral環境）での実行。

## 4. 運用ノウハウ：VEX (Vulnerability Exploitability eXchange)

「脆弱性は含まれているが、実際には悪用不可能である」ことを宣言する標準。
- SBOM だけでは「脆弱性がある」というアラートが多すぎてノイズになる。
- VEX を併用することで、QAや開発者が「対応不要」であることを機械可読な形式で記録し、監査を効率化する。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
