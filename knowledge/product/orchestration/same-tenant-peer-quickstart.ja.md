---
title: Same-Tenant Peer Quickstart
kind: orchestration
scope: repository
authority: runbook
phase: [onboarding, execution, review]
tags: [peer, mesh-hub, same-tenant, quickstart, conversation]
last_updated: 2026-10-18
---

# 同一 tenant の Kyberion peer をつなぐ最短手順

通信方式全体の判断基準は[Agent Communication and Coordination Model](../architecture/agent-communication-layer-model.md)を参照してください。この runbook の same-host は同じ host 上の**別 Kyberion runtime**を指します。同じ checkout 上で provider CLI を並走させる場合は peer server を起動せず、[Co-Session Coordination](../architecture/co-session-coordination.md)を使います。same_host は endpoint の到達範囲であり、信頼や作業権限を意味しません。

この runbook は、同じ tenant に属する Kyberion peer を起動し、相手を発見できることを確認してから会話を始めるための最短手順です。

運用者が覚えることは次の4つだけです。

```text
1. 相手 peer の接続情報を confidential に登録する
2. 同じ tenant-id で起動する
3. `mesh-hub:inspect peers` で healthy を確認する
4. `peer:conversation` で会話する
```

## 1. 接続情報を登録する

接続する側の Kyberion で、相手 peer の endpoint と共有 secret を登録します。secret は argv に書かず、環境変数から読み込みます。

```bash
export KYBERION_PEER_SHARED_SECRET_B='<受け取った共有シークレット>'
pnpm peer:register \
  --tenant-id demo \
  --peer-id kyberion-local-b \
  --base-url http://127.0.0.1:4101 \
  --shared-secret-env KYBERION_PEER_SHARED_SECRET_B \
  --exposure same_host
```

この操作は `knowledge/confidential/demo/connections/peer-network.json` に書き込みます。相手側からこちらへ送る場合は、相手側でも peer A の情報を同じ手順で登録します。

`--exposure` は接続方法の到達範囲です。

| exposure          | 用途                 | endpoint の扱い                    |
| ----------------- | -------------------- | ---------------------------------- |
| `same_host`       | 同一マシンの peer    | loopback のみ                      |
| `same_lan`        | 同一 LAN の peer     | private IP を許可                  |
| `private_network` | VPN / private subnet | tenant confidential に限定         |
| `public_network`  | 外部公開 endpoint    | public HTTPS 等。private IP は拒否 |

public 側の `knowledge/product/orchestration/peer-network.json` は、secret を持たない空の metadata template です。通常の送信先として使いません。

## 2. 起動する

peer ごとに異なる `peer-id`、port、共有 secret を使い、同じ `tenant-id` を指定します。

```bash
KYBERION_PEER_SHARED_SECRET="$PEER_A_SECRET" pnpm peer:conversation-server \
  --peer-id kyberion-local-a \
  --host 127.0.0.1 \
  --port 4100 \
  --tenant-id demo
```

別の端末で peer B を起動します。

```bash
KYBERION_PEER_SHARED_SECRET="$PEER_B_SECRET" pnpm peer:conversation-server \
  --peer-id kyberion-local-b \
  --host 127.0.0.1 \
  --port 4101 \
  --tenant-id demo
```

起動時に server が次を自動的に行います。

- Mesh Hub へ peer を enrollment する
- `peer.collaboration` capability を広告する
- heartbeat を開始する
- 終了時に maintenance 状態を記録する

`tenant-id` を付けない server は、通常の Peer Messaging listener にはなりますが、同一 tenant の Mesh discovery 対象にはなりません。

## 3. 発見を確認する

別の端末で次を実行します。

```bash
pnpm mesh-hub:inspect peers --tenant-id demo
```

次のように、対象 peer が `demo` tenant で `healthy` なら会話を開始できます。

```text
Peers (2)
- kyberion-local-a | demo | healthy | enrolled | ... | caps=peer.collaboration
- kyberion-local-b | demo | healthy | enrolled | ... | caps=peer.collaboration
```

合格条件は、次の3つです。

| 表示                          | 意味                           |
| ----------------------------- | ------------------------------ |
| tenant が同じ                 | tenant 境界を越えていない      |
| `healthy`                     | heartbeat が有効               |
| `enrolled` と capability 表示 | 受信可能な peer として登録済み |

ここで表示されない peer は、まだ「存在しない」のではなく、Mesh Hub が現在の送信先として安全に選べない状態です。まず server の `tenant-id`、port、共有 secret、runtime namespace を確認します。

## 4. 会話する

最初にローカル会話 session を作ります。

```bash
pnpm peer:conversation open-session \
  --local-peer-id kyberion-local-a \
  --remote-peer-id kyberion-local-b \
  --topic handoff \
  --title "同一 tenant の接続確認"
```

出力された `session_id` を使ってメッセージを送ります。

```bash
pnpm peer:conversation send-message \
  --local-peer-id kyberion-local-a \
  --remote-peer-id kyberion-local-b \
  --tenant-id demo \
  --session-id <session_id> \
  --topic handoff \
  --text "こちらから見えています。応答できますか？"
```

この通常メッセージは相手 peer の conversation responder が同期的に処理し、ACK を返します。Mesh Hub の collaboration request を送る場合は、`handoff` メッセージに型付き `collaboration_request` を付けます。受信側では proposal になり、`pnpm kyberion peer collaboration accept` を実行するまで mission や actuator は動きません。

## 5. 自動返事を有効にする（任意）

相手 peer からのメッセージに LLM が返事をするには、受け口サーバに相手の peer-id を明示的に渡します。指定しない限り自動返事は動かず、手動の会話はこれまでどおり使えます。

```bash
KYBERION_PEER_SHARED_SECRET="$PEER_A_SECRET" pnpm peer:conversation-server \
  --peer-id kyberion-local-a --host <LAN の IP> --port 4100 --tenant-id demo \
  --auto-reply-peers kyberion-local-b
```

- 自動の往復は 1 会話あたり `--auto-reply-max-turns`（既定 6）で止まり、相手ごとの生成回数も 1 時間あたりの上限で抑えられます。
- 返事は Claude がツールなし・設定なしの隔離状態で書き、使う材料はその会話の記録と tenant の knowledge の抜粋だけです。mission や actuator は動きません。
- tenant の confidential な内容を外部の LLM に送るので、事前に tenant の provider 証明（`training_use: none`、人の承認が 1 回必要）と、`api.anthropic.com` への送信許可が要ります。手順は [Peer Network Catalog](./peer-network.md) の「Conversation auto replies」を参照してください。
- Claude がなく Codex CLI だけがある端末では `--auto-reply-backend codex` を付けます。Codex はツールを無効にした隔離状態（読み取り専用、承認なし、MCP なし、空の作業フォルダ、最小限の環境変数）で返事を書きます。ただしモデルにはツールの定義が見えたままです。実行はできず、ツールを使おうとした返事は破棄され `tool_attempt_detected` として記録されます。動作確認済みの codex-cli のバージョン（現在 0.163）以外では止まります（`--auto-reply-allow-untested` で明示的に許可できます）。この場合の provider 証明は `--provider codex`、送信許可は `api.openai.com` です。
- 自動返事を有効にした相手には、この受け口の共有 secret を持つ全員に tenant の knowledge の抜粋が見える可能性があります。knowledge を見せてよい相手だけを指定してください。

## 6. 作業を依頼する（任意）

相手 peer に「実行」を頼むときは、会話ではなく型付きの作業依頼を使います。依頼側は作業の種類の名前だけを送り、何を実行するか（固定のパイプラインか、固定引数の `pnpm` スクリプト）と誰から受けるかは、受け手の `knowledge/confidential/<tenant>/connections/peer-tasks.json` が決めます。

```bash
# 依頼側
pnpm kyberion peer task propose --peer-id <自分> --tenant-id <tenant> --to-peer <相手> \
  --task-type baseline.check --summary "引き継ぎ前に健全性を確認したい"

# 受け手側（届いた依頼を確認して受理）
pnpm kyberion peer task list --peer-id <自分> --tenant-id <tenant> --state pending
pnpm kyberion peer task accept --peer-id <自分> --tenant-id <tenant> --task-id <ID> \
  --actor-id <自分の名前> --reason "<受理理由>"
```

受理すると WorkItem として実行され、報告とログは受け手側に成果物として残り、依頼側には sha256 付きの参照だけが返ります。届いた時点では何も実行されません。途中で止まった依頼は `resume`、結果の再送は `resend-result` を使います。詳細は [Peer Network Catalog](./peer-network.md#typed-peer-tasks) を参照してください。

## つまずいたときの判断

```text
peers に出ない
  → tenant-id / namespace / heartbeat を確認

peers に出るが送れない
  → peer-network.json の endpoint / shared secret を確認

送れるが collaboration が進まない
  → recipient 側の proposal を list して、operator が accept する
```

`peer-network.json` は接続先と HMAC secret を解決する tenant confidential transport catalog です。catalog に登録しただけでは live peer にはなりません。live discovery は enrollment、tenant、有効な heartbeat、capability の組み合わせで判定されます。

## やってはいけないこと

- runtime の Mesh Hub JSONL を手で編集しない
- 異なる tenant-id の peer を同じ discovery として扱わない
- `mesh-hub:inspect peers` に出ていない peer を無理に宛先にしない
- collaboration や作業依頼の受信を mission lifecycle や任意 actuator の自動実行と解釈しない（作業依頼は受け手が受理したときだけ、受け手の catalog にある固定の処理が動く）

詳細な transport、proposal、LAN 設定は [Peer Network Catalog](./peer-network.md) を参照してください。
