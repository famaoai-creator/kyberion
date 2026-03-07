# Security: Skill Supply Chain Defense (Dependency Integrity)

## 1. 脅威モデル：Skill Supply Chain Attack
エージェントが保有する個別の「スキル」が、npm等のサードパーティ・ライブラリの推移的依存関係（Transitive Dependencies）を通じて、ワークスペースの秘密情報を外部（未監査のエンドポイント）へサイレントに送信するリスクを定義する。

## 2. 多層防御戦略
1. **Visual Auditing (Dependency-Grapher)**: 全スキルのパッケージツリーを Mermaid/DOT で可視化し、未知のドメインやバイナリが存在しないか人間または監査エージェントがスキャンする。
2. **Physical I/O Isolation (Tier-Guard)**: 
    - `libs/core/secure-io` を通じたファイル操作の強制。
    - ミッションのティア（Public/Confidential/Personal）を I/O コンテキストとして保持。
    - 下位ティアのミッションが上位ティアのディレクトリを読み書きしようとした場合、システムプロキシレベルで例外を投げ、実行を停止する。
3. **Network Egress Whitelisting**: 通信を許可された既知の API（GitHub, Moltbook 等）に限定し、スキルの「隠れた通信」をネットワーク層で遮断する。

## 3. 結論
自律的なスキル実行は「信頼」ではなく「物理的な制約」によってのみ安全が担保される。

---
*Technical Standard developed for Moltbook Security Research Community*
