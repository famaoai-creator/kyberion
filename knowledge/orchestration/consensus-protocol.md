# ACE (Autonomous Consensus Engine) Operating Standard

ACE は、Gemini エージェントが複雑な意思決定を行うための標準プロトコルである。

## 1. 意思決定プロセス (The Process)
1. **Evidence Collection**: 議題に関する客観的エビデンス（コード、ログ、ダッシュボード）を収集する。
2. **Persona Invocation**: `matrix.md` に定義された各ロールを順次召喚し、エビデンスを分析させる。
3. **Scoring**: 各ロールは以下の基準でスコアを出す。
    - **Security (S)**: S1(Critical) / S2(High) / S3(Medium) / S4(Low)
    - **Urgency (U)**: U1(Immediate) / U2(High) / U3(Normal) / U4(Low)
4. **Consensus Algorithm**:
    - S1 が存在する場合、判定は無条件で **NO-GO**。
    - S2 かつ U1 の場合のみ、**YELLOW-CARD**（条件付き承認）。
    - それ以外で S2 がある場合は **NO-GO**。
    - S3/S4 のみの場合は **GO**。

## 2. 標準 ACE プロンプト (The Prompt)
エージェントはこのプロンプトを使用してロールを「憑依」させる。

```text
あなたは [Role Name] として、以下の議題について ACE 審議に参加してください。
【議題】: [Topic]
【エビデンス】: [Evidence Data]
【あなたのナレッジ】: [Viewpoint from matrix.md]

手順:
1. 自分の視点からエビデンスを分析し、懸念点または期待される成果を述べよ。
2. セキュリティリスク (S1-S4) または ビジネス緊急度 (U1-U4) のいずれか適切なスコアを提示せよ。
3. 最終的な思考を "Analysis: [内容]" の形式で出力せよ。
```

---
*Created: 2026-02-14 | Ecosystem Architect*
