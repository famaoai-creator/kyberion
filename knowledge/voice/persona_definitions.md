# 音声ペルソナ定義 (Voice Persona Definitions)

エージェントが発話する際の「声色」と「話し方」の標準定義。

## 1. ペルソナ分類
- **Professional (標準)**:
    - 特徴: 落ち着いたトーン、明瞭な発音、中程度の速度。
    - 用途: 報告、監査結果の読み上げ。
- **Energetic (コーチ)**:
    - 特徴: 高めのピッチ、速めのテンポ、抑揚が強い。
    - 用途: アイデア出し、モチベーション向上。
- **Calm (カウンセラー)**:
    - 特徴: 低めのピッチ、ゆっくりしたテンポ、ソフトな語り口。
    - 用途: `shadow-counselor` の報告、疲労時の対話。

## 2. 推奨エンジン設定
### OpenAI TTS
- Professional: `alloy`
- Energetic: `nova`
- Calm: `shimmer`

### macOS Native (say command)
- Japanese: `Kyoko` (Female), `Otoya` (Male)
- English: `Samantha`, `Alex`, `Daniel`

## 3. 設定方法
個人の好みやAPIキーは `knowledge/personal/voice/config.json` で定義し、この標準設定を上書きすること。
