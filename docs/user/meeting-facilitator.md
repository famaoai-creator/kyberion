# Meeting Facilitator Use Case

Kyberion can participate in a meeting on the operator's behalf, listen,
capture action items, and help track follow-up work. The workflow is
designed to fail closed: speaking requires explicit consent, and browser
targets are allow-listed before the join step starts.

## When to use it

Use this path when you want Kyberion to:

- join a scheduled meeting,
- capture a transcript or summary,
- extract action items,
- complete the operator's own follow-up work, and
- record an audit trail for later review.

## 最短の参加依頼シナリオ

次のように、会議URLと「してほしいこと」だけを添えて依頼できます。プラットフォームはURLから判定します。

```text
このミーティングに参加して。
URL: https://meet.google.com/xxx-xxxx-xxx
私の代わりに聞いて、要点とアクションアイテムを整理して。発言はしないで。
```

Kyberion は次の順番で進めます。

1. URL、参加時の役割、会議の目的だけを確認する
2. 参加前に、聞くだけ／議事録／進行／必要時の発言を含む実行プランを表示する
3. 発言が指定されていない場合は、聞くだけ・発言なしで参加する
4. runtime と同意を確認してから会議へ参加する
5. 退出後に要点、アクションアイテム、フォローアップを返す

URLだけで依頼を始めることもできます。その場合は、次の2点だけを追加で確認します。

- 会議の目的と、会議中に何をしてほしいか（聞くだけ／議事録／進行）
- 発言を許可するか（既定は発言なし）

繰り返し使う場合は、同じ確認を毎回入力せず、参加依頼シナリオとして保存できます。

```bash
pnpm task:list
pnpm task:init meeting-participation-request --print-template
pnpm task:run meeting-participation-request --dry-run
```

このシナリオは、参加前の確認と dry-run を担当します。実際の会議へ入るときは、確認済みの mission と同意境界を引き継いで `pnpm meeting:participate` を使います。

## What is safe by default

- `join`, `listen`, `chat`, and `leave` are available without speaking consent.
- `speak` is blocked unless the active mission has a granted `voice-consent.json`.
- Live `meeting:participate` also checks the same mission-scoped `voice-consent.json` before recording/capture starts and again before TTS speech.
- Meeting hosts are validated before the browser join step can run.
- Meeting URLs are logged as redacted host-only values in audit/trace output.

## Consent boundary

Consent is per mission, not global. Grant it only for the meeting mission you are about to run:

```bash
pnpm meeting:consent grant \
  --mission MSN-... \
  --operator <handle> \
  --scope "recording/capture and TTS speech for <meeting purpose>" \
  --expires-at "2026-05-15T18:00:00.000Z"
```

The consent file lives in the mission evidence directory as `voice-consent.json`.
If it is missing, revoked, expired, malformed, tied to another mission, or tied
to another tenant, Kyberion fails closed. It will not start live capture, and it
will not speak.

## Dry run vs real meeting

### Dry run

Use a dry run when you want to verify the workflow contract without a live call.

```bash
pnpm cli preview pipelines/meeting-proxy-workflow.json
pnpm run test:meeting-dry-run
```

This checks the structure of the workflow and shows the intended stages
without opening a meeting. It is the right path for CI, onboarding, and
operator rehearsal.

### Real meeting

Use the participation path only when the meeting is real and the mission
has the required environment readiness.

```bash
pnpm doctor:meeting --mission MSN-...
pnpm meeting:consent grant --mission MSN-... --operator <handle>
pnpm meeting:participate \
  --mission MSN-... \
  --meeting-url "https://meet.google.com/..." \
  --platform meet
```

If the environment is missing browser or audio capability, bootstrap the
meeting runtime first and resolve the missing prerequisites before retrying.

```bash
pnpm env:bootstrap --manifest meeting-participation-runtime --apply
```

Real meeting mode can open a browser, capture meeting audio, run STT/TTS, and
write trace/audit evidence. Do not use it as a connectivity test; use the dry
run commands above until the target meeting and consent are real.

## Dictation fallback for notes

If STT is not configured, you can still use the browser surface as a dictation
front-end:

- open `presence-studio`,
- switch the voice capture mode to `Notes Capture`,
- dictate into the browser mic, and
- click `Create Minutes` to save a markdown minutes artifact.

This path keeps the captured text local until you decide to generate minutes.
If the browser's speech recognition is unavailable, fall back to the OS dictation
shortcut or paste the text manually before creating the minutes. Browser Web
Speech support still depends on the browser implementation, so offline behavior
is not guaranteed there.

## What happens after the meeting

Kyberion can turn the transcript into action items, mark the operator's
own work as complete or blocked with a reason, and leave reminders for
other attendees. The resulting actions and trace entries stay attached to
the mission for audit and follow-up.
