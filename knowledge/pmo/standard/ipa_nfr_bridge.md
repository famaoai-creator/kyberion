# PMO Bridge to IPA Non-Functional Grade

非機能要求を「技術者のこだわり」から「経営判断の指標」へ変換する基準。

## 1. 意思決定の重み付け (ACE Priority)
大規模更改において、IPAグレードのどの項目を優先するかを定義する。

- **可用性 (Availability)**: 更改直後は最もクリティカル。ACE S1判定の基準とする。
- **性能・拡張性 (Performance)**: `PERFORMANCE_DASHBOARD.md` と連動し、SLO遵守率 95%以下をリスクとして検知する。
- **運用・保守性 (Maintainability)**: VoltMX Migration において「将来の React 移行」を阻害する設計を S2リスクとして弾く。

## 2. 実装エビデンスとしての活用
`nonfunctional_requirements.md` に記載された 270項目のグレードを、ACE Engine が議論を行う際の「客観的基準（Truth）」としてロードさせる。

---
*Created: 2026-02-14 | PMO Role*
