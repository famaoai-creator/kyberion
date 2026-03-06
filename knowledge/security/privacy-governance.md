---
title: Data Privacy & Governance: APPI & GDPR Compliance
category: Security
tags: [security, privacy, governance]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Data Privacy & Governance: APPI & GDPR Compliance

このドキュメントは、日本の個人情報保護法 (APPI) および EU 一般データ保護規則 (GDPR) に基づき、データのライフサイクル全体における法的遵守とユーザーの権利を保護するための標準規約である。

## 1. 主要な法規制の概要

### APPI (日本の個人情報保護法)
- **個人情報**: 生存する個人に関する情報で、特定の個人を識別できるもの。
- **要配慮個人情報**: 人種、信条、社会的身分、病歴など、不当な差別や偏見を生じさせるおそれがある情報。
- **第三者提供**: 原則として本人の同意が必要。

### GDPR (EU 一般データ保護規則)
- **適用範囲**: EU 内の個人にサービスを提供する全ての組織に適用。
- **データ主体の権利**: アクセス権、訂正権、消去権（忘れられる権利）、データポータビリティ権。
- **DPA (Data Processing Agreement)**: 処理者（ベンダ）との契約締結。

## 2. プライバシー保護の設計 (Privacy By Design)

- **Data Minimization (データ最小化)**: 目的達成に必要な最小限のデータのみを収集する。
- **Pseudonymization (仮名化)**: 他の情報と照合しない限り個人を特定できない状態。内部分析用。
- **Anonymized Data (匿名加工情報)**: 復元不可能。第三者提供や統計公開が可能。
- **Individual Related Information (個人関連情報)**: Cookie等の識別子。提供先で個人データとなる場合は本人の同意が必須。

## 3. データ処理の透明性

- **プライバシーポリシー**: 収集目的、利用方法、保存期間、連絡先を明文化し、容易にアクセス可能にする。
- **同意管理**: ユーザーが自由意思で、かつ明確なアクションによって同意を選択できる仕組み。

## 4. インシデント発生時の対応

- **通知義務**: 漏洩等が発生し、個人の権利利益を害するおそれが大きい場合、速やかに当局（個人情報保護委員会等）および本人に通知する。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
