---
title: 業務SaaSの承認キューを人の都度承認なしで点検する設計
tags: [governance, autonomy, browser, delegation, chronos, approval]
last_updated: 2026-11-16
status: active
concepts: [actuator-op, grant, pipeline, tenant]
runtime_stages: [alignment, execution]
---

# 業務SaaSの承認キューを人の都度承認なしで点検する設計

承認TIME・請求QUICK・勤怠（Company Works）など、ログインが必要な業務 SaaS の承認待ちを、テナントごとに定期点検する。人が関わるのは、委任範囲への署名と、ルールから外れた案件の判断だけにする。全体の考え方は [受信と実行権限を分離する自律ループ](../governance/delegated-autonomous-loop.md) に従う。

## 1. なぜ既存の仕組みでは止まるか

- ブラウザの `goto`・`fill`・`click` は外部操作として毎回人の承認を求める。委任できるのは、JavaScript を無効にした公開ページの閲覧（`isolated-public-read-v1`）だけである。ログインして一覧を読む操作は対象外になる。
- 生のクリックを委任すると、どのボタンを押すかをパイプラインの記述が決めることになる。承認ボタンも同じクリックとして通ってしまう。
- 既存の委任経路（`createOnboardingExternalOperationAuthority`）は、実行元が confidential tier のとき VCS 以外を委任しない。

## 2. 委任の単位は業務操作にする

委任の単位は生のクリックではなく、`browser:approval_queue_inspect`（承認キューの点検）という一つの業務操作にする。この操作は型付きの actuator op として実装し、中でログイン・一覧への移動・件数と案件の取得を行う。承認・却下・差し戻しは行わない。

- **対象の宣言**: ログイン URL・入力欄・一覧の位置は、テナントの点検プロファイル（`knowledge/confidential/{tenant}/approval-queues/{system}.json`）に宣言する。プロファイルの書式と全項目は [browser-actuator の README](../../../libs/actuators/browser-actuator/README.md#tenant-approval-queue-inspection) にある。プロファイルは project-trust ではなく、§4 の grant に書くハッシュで人の署名に束縛する。
- **押してはいけないボタン**: クリックの直前に、ボタンの文字・value・`aria-label`・`title` のどれかが承認・却下・差し戻し・確定などの語であれば、op はクリックせずに止まる。ログインボタンも対象になる。これは多層防御で、委任の境界は §4 のプロファイルハッシュである。
- **待ち合わせ**: ログイン完了の目印（`login.success_selector`）、一覧の表示完了の目印（`list.ready_selector`）、0 件表示の目印（`list.empty_selector`）は必須とする。行が 0 件で 0 件表示も見えていないときは、0 件と報告せずに失敗にする。セレクタの誤りを「承認待ちなし」と取り違えないためである。画面に隠れたまま置かれた 0 件表示は数えない。一覧がページに分かれるシステムでは、件数表示（`list.total_selector`）からシステム自身の総数を読む。読んだ総数が表示中の行数より少なければ、件数表示の指定が誤っているとみなして失敗にする。
- **認証情報**: op の中で secret-guard から取得する。パイプラインの記述や結果に値を残さない。
- **時間と量の上限**: 各操作は 30 秒、点検全体は 180 秒で打ち切り、ブラウザを必ず閉じる。返す案件は既定 200 件、各値は 512 文字、全体で 256 KB までにする。テナントの機密情報をパイプラインの記録に無制限に流さないためである。

## 3. 許可サイトへの閉じ込め（`authenticated-origin-set-v1`）

点検は新しい閉じ込め機能を付けたブラウザでだけ委任できる。

- ブラウザの全通信を、宣言した HTTPS オリジンの集合に限定する。それ以外への要求は送信前に遮断する。
- リダイレクトは自動では追わない。毎回応答を受け取ってから、行き先が許可オリジンかを確かめる。
- service worker・ダウンロード・リモートデバッグポートは無効にする。WebSocket も許可オリジン以外は遮断する。
- 宣言したホスト以外は、ブラウザ内で名前解決できないようにする。要求の振り分けを通らない preconnect や DNS への漏れを防ぐためである。WebRTC はページのスクリプトが動く前に無効にする。一覧を読むのに不要な動画・音声・フォントは取得しない。
- ブラウザは毎回メモリ上の新しい状態で起動し、以前のログイン状態を持ち込まない。追加認証（MFA）が必要な Garoon は、この段階の対象外とする。
- 通信はすべて Node 経由で取得するため、外向きの HTTP プロキシが必要な環境では動かない。

公開ページ閲覧用の閉じ込めと違い、JavaScript とフォーム送信は許可する。ログインと ASP.NET のポストバックに必要なためである。その代わり、送信先は許可オリジンに限られる。

## 4. 委任の判定

責任憲章（`knowledge/confidential/{tenant}/charters/`）の `envelope.external_operations` に、次の形の grant を人が署名して置く。

```json
{
  "operation_id": "browser:approval_queue_inspect",
  "origin": "https://wf.shonin-time.jp",
  "profile_hash": "<点検プロファイルの SHA-256>"
}
```

実行時には次の条件をすべて満たすときだけ委任が成立する。一つでも欠けたら、従来どおり人の承認待ちになる。

1. ブラウザに `authenticated-origin-set-v1` が付いていて、許可集合が点検先のオリジン 1 つだけである。ログイン用に別ドメインを使うシステムは、当面は人の承認で実行する。
2. 憲章の grant のオリジンとプロファイルのハッシュが、実行するものと一致する。プロファイルは認証情報の選択と画面の移動手順を決めるため、人が署名した手順でしか委任しない。署名する人には、ハッシュだけでなくプロファイルの中身（オリジン、認証情報のキー、移動手順）を見せる。
3. 実行元テナントと憲章のテナントが一致し、憲章の `data_tier.read` が `confidential:{tenant}` を含む。点検はテナントの業務システムからテナントの証跡へ情報を取り込む操作である。外へ出るのは、そのシステム自身の認証情報だけになる。
4. プロセスが、そのテナントで承認済みの NHI セッションを持っている（`pnpm onboarding nhi-session`）。

委任された外部操作は、評価上は取り消せない操作として扱われる。憲章の `irreversible` が `named_actions_only` の場合は、`irreversible_named_actions` に `browser:approval_queue_inspect` を含める。

署名する grant は `pnpm kyberion browser approval-queue <プロファイル>` で表示する。このコマンドは、ハッシュ（`shasum -a 256 <プロファイル>` と同じ値）、ログインに使う認証情報の名前、ログイン URL と移動手順、そのまま憲章に書ける grant を出力する。ハッシュはファイルのバイト列から計算するので、整形し直しただけでも値が変わり、署名し直しが必要になる。

grant の書き方を誤ると、憲章の検証が何番目の grant のどこが誤りかを返す。

### 定期実行が人の承認待ちに戻ったとき

委任が成立しないと、点検は失敗せずに人の承認待ちになる。次の順に確かめる。

1. プロファイルを変更していないか。`pnpm kyberion browser approval-queue` のハッシュと憲章の grant を比べる。
2. NHI セッションの有効期限が切れていないか。
3. 憲章の `data_tier.read` に `confidential:{tenant}` があるか。
4. プロファイルの `origins` が 1 つだけか。

## 5. 失敗の扱い

点検は読むだけの操作なので、失敗しても相手のシステムに残る変化はない。失敗は failed として記録し、人の確認を待たずに次の定期実行で最初からやり直す。同じ実行の中では再試行しない（パイプラインの `on_error` で retry を指定しない）。書き込みを伴う外部操作の失敗は「結果を確かめるまで再実行しない」として止めるが、点検はその対象にしない。

エラーは `[コード] 何が — なぜ | next: 次にすること | evidence: 証拠` の形で返す。証拠には失敗した段階（ログイン、`navigate[2]`、一覧など）、セッション ID を除いた URL、閉じ込めが遮断したホスト名が入る。夜間の失敗でも、人が再実行せずに原因を特定できるようにするためである。コードの一覧は README にある。

## 6. 定期実行

新しいシステムを点検対象に加える手順は次のとおり。

1. `knowledge/confidential/{tenant}/approval-queues/{system}.json` にプロファイルを書く。委任するなら `origins` は 1 つにする。
2. 認証情報を `pnpm kyberion secret introduce <service> <KEY>` で登録する。名前は `<SERVICE>_<KEY>` になる。
3. `headless: false` で一度、人の承認つきで実行し、件数と案件が画面と合うことを確かめる。
4. `pnpm kyberion browser approval-queue` が出力する grant を責任憲章に署名して置き、`data_tier.read` と `irreversible_named_actions` を設定する。
5. NHI セッションを承認する。
6. `knowledge/confidential/{tenant}/pipelines/` に `schedule` 付きのパイプラインを置く。Chronos がテナントに限定した子プロセスで起動する。`runtime.authorized_scope` で点検先の認証情報を 1 サービス分だけ渡し、件数が 0 でなければ通知する手順と、最後に `core:organization_record_run` で実施記録を残す手順を入れる。

## 7. 承認の自動化（段階 2）

段階 2 で `browser:approval_queue_approve` を追加する。案件ごとに、金額上限・申請者・種別をルールで判定する。

- ルール内の案件は自動で承認し、一覧から消えたことを確かめて成功とする。
- ルールから外れた案件は、concierge の承認画面に要約付きで 1 件ずつ回す。
- 上限は責任憲章の停止条件（tripwire）に置く。承認は取り消せないため、責任者が稼働中であることを実行ホストが確認できないときは自動承認しない。

## 8. 人が関わる場面

| 場面                                 | 頻度                                     |
| ------------------------------------ | ---------------------------------------- |
| 責任憲章への grant の署名            | 初回と、点検先やプロファイルを変えたとき |
| パイプラインの project-trust 承認    | 初回と、内容を変えたとき                 |
| NHI セッション承認の更新             | 有効期限ごと（現行の上限は 7 日）        |
| ルールから外れた案件の判断（段階 2） | 例外の案件ごと                           |

NHI セッションの有効期限は意図的に上限が設けられている。定期実行専用に、パイプラインの内容ハッシュへ束縛した長期の承認を設けるかは、別途判断する。

## 9. 段階と検証

- **段階 1a（基盤と点検 op）**: 閉じ込め機能、点検プロファイルの実行エンジン、`browser:approval_queue_inspect` の委任対象登録、confidential tier の委任判定、grant を表示するコマンド。許可外オリジンの遮断、承認系ボタンの拒否、段階ごとの失敗の分類、条件が欠けたときに人の承認へ戻ることをテストで示す。
- **段階 1b（テナント設定）**: Chronos から NHI セッションを渡す設定、concierge の委任設定画面への grant 追加、テナントごとのパイプラインとプロファイル。実際の業務 SaaS で、Cookie の扱いと件数が画面と合うことを確かめる。
- **段階 2**: ルールによる自動承認と、例外の人への回付。
