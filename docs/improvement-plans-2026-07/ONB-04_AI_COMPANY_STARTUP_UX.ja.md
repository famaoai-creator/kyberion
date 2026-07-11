# ONB-04: AI会社を始めるための起業オンボーディングUX

> **優先度**: P0 / **規模**: M / **依存**: ONB-01、ONB-02、ONB-03、CO-06、E2E-04

> **実装状況 (2026-07-12)**: `pnpm company:onboard`、dry-run、会社readiness、human owner、初期AI worker、承認/予算境界、first-work plan、CLIドキュメントを実装済み。

## 結論

既存の `pnpm onboard` は、個人のidentity・推論backend・接続候補・tenant・tutorialを設定するウィザードである。AIを主な労働力として会社を始める入口としては、会社profileの作成、最終責任者、AI workforce、承認境界、予算、最初の業務が別々に分散している。

AI会社の開始は、次の一つの成果物を作るべきである。

```text
Company overlay
  -> accountable human
  -> AI workforce
  -> approval and budget boundaries
  -> first-work plan
  -> readiness report
```

## UXの不足

1. `company:bootstrap` はテンプレート展開だけで、責任者やAI役割が登録されない。
2. `pnpm onboard` は個人オンボードであり、会社を開始したのか判断できない。
3. AIが何を実行でき、何を人間が承認するかが初回画面に出ない。
4. 予算の既定値・停止条件が会社単位で確認できない。
5. 最初に実行すべき業務がtutorialの文章に留まり、reviewable work planになっていない。
6. dry-run、実適用、再実行時の書き込み範囲が一つのreadiness reportにまとまっていない。
7. 初回成功後に `KYBERION_CUSTOMER`、setup report、mission開始へ進む導線が弱い。

## 実装済みの開始導線

```bash
pnpm company:onboard \
  --vertical saas-product-company \
  --slug acme-ai \
  --name "ACME AI" \
  --owner-id human:founder \
  --goal "最初の顧客課題と販売計画を定義する"
```

`--dry-run` は書き込みなしで、会社ディレクトリ、readiness report、first-work plan、次のコマンドを表示する。

実適用時には次を作る。

- 業態テンプレートからの `customer/{slug}/` overlay
- `accountable_human_resource_id`
- `solo_founder_ai_workforce` profile
- AI CEO Operator resource（人間ownerへのaccountability束縛付き）
- human approvalが必要な操作一覧
- 予算posture `block`
- `ai-company-readiness.json`
- 人間レビュー前提の `first-work-plan.md`

## 不変条件

1. AI会社のオンボーディングはhuman accountable ownerなしに `ready` にならない。
2. AI workerには必ず `accountable_human_id` がある。
3. AI会社オンボードは予算postureを暗黙のwarnにせず、初期値をblockとして表示する。
4. first-workは自動実行せず、human review前の `planned` で止める。
5. `--dry-run` は会社overlayや秘密を作成しない。
6. 再実行は既存overlayを暗黙上書きせず、`--force`を要求する。
7. 会社のreadinessが未完でも、個人の既存onboarding成果物を破壊しない。

## 受入条件

- 新規ソロプレナーが1コマンドで会社overlay、human owner、AI worker、承認境界、予算、first-workを確認できる。
- dry-runでファイル変更が0件であることをテストできる。
- 実適用結果に、次のコマンド（customer切替、setup report、mission開始）が含まれる。
- `organization-profile.json` がschema検証を通る。
- human ownerを変えた再実行結果がreadinessとprofileの両方に反映される。
- AI workerのaccountability欠落はschemaまたは適用時に拒否される。
- 既存 `company:bootstrap`、`pnpm onboard`、customer overlayの互換性を壊さない。
- first-work planが「実行済み」と誤表示せず、scope・承認・受入確認を要求する。

## 今後の拡張

- onboarding画面からの業務goal入力とmission preview
- service接続を1件ずつ実接続・preflightするguided setup
- AI workerごとのcapability、cost cap、停止条件の編集
- first-work完了後のhuman acceptanceと会社Homeへの自動遷移
- `ai-company-readiness.json` をproduction evidenceへ昇格
