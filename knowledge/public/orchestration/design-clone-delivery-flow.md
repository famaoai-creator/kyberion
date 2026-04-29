# Design Clone Delivery Flow

`このアプリのデザインを踏襲して、こういうコンセプトのサイト/アプリを作って。設計書とテスト結果も出して。`

という依頼を、Kyberion がどう受けるかの上位 orchestration です。

## Intent Mapping

この依頼は 4 つに分解されます。

1. design reference extraction
2. concept-driven implementation
3. specification generation
4. test and evidence generation

## Platform Split

Web:

- [`design-clone-and-build-web.md`](/Users/famao/kyberion/knowledge/public/procedures/service/design-clone-and-build-web.md)

Mobile:

- [`design-clone-and-build-mobile.md`](/Users/famao/kyberion/knowledge/public/procedures/service/design-clone-and-build-mobile.md)

Deliverables:

- [`deliver-design-spec-and-test-pack.md`](/Users/famao/kyberion/knowledge/public/procedures/service/deliver-design-spec-and-test-pack.md)

Intake:

- [`design-clone-request-intake.md`](/Users/famao/kyberion/knowledge/public/templates/blueprints/design-clone-request-intake.md)

## Current Readiness

Web:

- high
- 既存観察、profile、flow modeling、test inventory、browser execution plan まである

Mobile:

- medium
- 観察、profile、skeleton、debug automation はある
- production-ready native completion は追加実装が必要

## Recommended Operator Response

依頼を受けたら最初に次を確定する。

1. platform: web or mobile
2. reference source
3. preserved design elements
4. new concept
5. required deliverables
6. execution environment

その後、platform-specific procedure に入る。
