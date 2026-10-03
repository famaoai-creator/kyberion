---
category: Fixed
---

- **回復不能・孤立する held action の状態を解消** — (1) クラッシュで途切れた journal の末尾行に次のイベントが連結されて失われる問題（追記を改行始まりに）。(2) 承認リクエストが決裁・取消・失効済みなのにブリッジ未達で held が `pending` のまま残り、再決裁も拒否される問題を、リクエスト側から冪等に突き合わせる `reconcileLinkedApprovals` で解消（refresh / 一覧 / drain で実行）。(3) `dependsOn` を apply で強制し、依存先が却下・失敗・取消・不存在の依存元は `cancelled` に、未完了なら待機に（却下時に承認済み依存元が残る、失敗した依存先の後で依存元が実行される問題）。drain は依存の順序違いでも 1 回で完了。(4) 実行できなくなった pending/approved の action を人間が取り消す `cancelHeldAction`（紐づく承認リクエストも取消、claim 未解放なら拒否）。(5) 実行後の結果書き込みが一時的に失敗しても再試行して claim だけが残らないように。
