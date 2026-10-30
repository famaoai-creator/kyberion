---
title: エンジン実行設定の保存と安全な解決
tags: [voice, perception, runtime, configuration, scope]
last_updated: 2026-10-31
---

# 既定のエンジンを保存する

権限のあるoperator文脈で設定する。設定は現在のprofileに保存され、環境変数を恒久変更しない。

    pnpm voice:engine-config show
    pnpm voice:engine-config set --ffmpeg-bin /opt/bin/ffmpeg --python-bin /opt/bin/python3 --agent-runtime-backend pipe --dry-run
    pnpm voice:engine-config set --ffmpeg-bin /opt/bin/ffmpeg --python-bin /opt/bin/python3
    pnpm voice:engine-config unset ffmpeg-bin --dry-run
    pnpm voice:engine-config unset ffmpeg-bin

binaryは絶対パスを指定し、前後の空白は保存・読込時に正規化する。agent-runtime-backendはpipeまたはpaneだけを受理する。showは全設定を表示し、--jsonで構造化出力になる。set/unsetのdry-runも保存時と同じ検証を行い、書き込まない。resetは空の既定値へ戻す。引数値が--で始まる場合は--flag=value形式を使う。

実行時は明示引数・環境変数を先に解決し、必要な場合だけ保存設定を参照する。続いてmanaged/registry、組み込み既定値を使う。保存されたstreaming bridge IDは既定候補であり、能力要件・scopeのpin・選択ルール・明示purposeを上書きしない。未知または不適格な候補は選択理由に残り、安全な候補がなければ未解決になる。

# profileと権限の境界

設定は呼出しごとに現在のprofileと読取権限を確認して再読込する。返却値は不変のsnapshotで、他の呼出しやprofileを変更しない。別CLIによる変更・作成・削除も次の読取に反映される。

consumerのreadinessはready/missing/unavailableを区別する。現在の権限に個人profileの一般的な読取権限がない場合だけunavailableとなり、存在確認も行わず組み込み側の解決を続ける。roleの明示拒否、resource ceiling、tenant/scope矛盾、壊れたpolicy、参照する設定のJSON/schema不正、symlinkやI/Oの異常は「設定なし」に変換しない。設定CLIのstrict APIは未認可時にエラーを返す。資格情報のtask binding不足は、非秘密の設定を読む権限と同一ではない。

明示的に注入したenvはlive profileと分離する。保存したFluidAudio設定は次の登録時に再評価し、変更・解除・profile切替では自分の登録だけを更新する。同名pluginや後から置き換わった登録は削除しない。進行中の録音・再生・workerは途中で切り替えない。

検証はengine-runtime-preferences、tier-guard-engine-runtime、engine_runtime_config、各consumerとseam-provider-selectionの回帰テストで行う。CLI追加時はscript登録、script数の登録ceremony、語彙typesとpseudo-localeの生成も同時に確認する。

# Presence Studioから編集する

ローカルのPresence Studioでエンジン設定画面を開く。画面は現在のprofileを表示し、読込が成功してから編集できる。変更した項目だけを保存し、保存済みの値を空欄にするとその項目を解除する。保存後はサーバーが正規化した値を表示する。環境変数による上書きは引き続き優先される。

別CLIや別画面で設定が変わった場合は競合として保存を止め、再読込を案内する。通信失敗や権限不足でも成功表示へ切り替えない。設定の読書きは、サーバーが解決したローカル管理者・ローカルHost・変更元Originを検証した後、対象profileの設定ファイルに限定して実行する。remote tokenからの個人設定の参照・更新や、URL/bodyによるprofileの切替は許可しない。
