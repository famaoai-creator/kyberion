# ローカル LLM ランタイム セットアップ & 運用ランブック

本ランブックでは、Kyberion でサポートされているローカル LLM ランタイム（Ollama, vLLM, LM Studio, llama.cpp, MLX-LM, LocalAI）のセットアップ、起動手順、環境変数設定について解説します。

## サポート対象ランタイム一覧

| ランタイム        | バックエンドモード (`KYBERION_REASONING_BACKEND`) | デフォルト URL              | 参照環境変数             | 既定モデル(未指定時) | Context Window                       |
| ----------------- | ------------------------------------------------- | --------------------------- | ------------------------ | -------------------- | ------------------------------------ |
| **Ollama**        | `ollama`                                          | `http://localhost:11434/v1` | `KYBERION_OLLAMA_URL`    | `llama3.2`           | モデル registry または明示値         |
| **vLLM**          | `vllm`                                            | `http://localhost:8000/v1`  | `KYBERION_VLLM_URL`      | `vllm-model`         | モデル registry または明示値         |
| **LM Studio**     | `lmstudio`                                        | `http://localhost:1234/v1`  | `KYBERION_LMSTUDIO_URL`  | `lmstudio-model`     | モデル registry または明示値         |
| **llama.cpp**     | `llamacpp`                                        | `http://localhost:8080/v1`  | `KYBERION_LLAMACPP_URL`  | `llama-model`        | モデル registry または明示値         |
| **MLX-LM**        | `mlx`                                             | `http://localhost:8080/v1`  | `KYBERION_MLX_URL`       | `mlx-model`          | モデル registry または明示値         |
| **LocalAI**       | `localai`                                         | `http://localhost:8080/v1`  | `KYBERION_LOCALAI_URL`   | `localai-model`      | モデル registry または明示値         |
| **Generic Local** | `local`                                           | `http://localhost:11434/v1` | `KYBERION_LOCAL_LLM_URL` | `llama3`             | 未知の場合は max_tokens を推測しない |

---

## 1. Ollama のセットアップ

### インストール

- **macOS / Linux**: [ollama.com](https://ollama.com) からダウンロードまたは `brew install ollama`
- **Docker**: `docker run -d -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama`

### モデルの取得

推奨コーディング/推論モデルをプルします:

```bash
ollama pull llama3.2
ollama pull qwen2.5-coder
```

### Kyberion 連携設定

```bash
export KYBERION_REASONING_BACKEND=ollama
export KYBERION_OLLAMA_URL=http://localhost:11434
export KYBERION_OLLAMA_MODEL=qwen2.5-coder
```

---

## 2. vLLM のセットアップ

### インストール

```bash
pip install vllm
```

### サーバー起動

```bash
python3 -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-Coder-7B-Instruct \
  --port 8000 \
  --max-model-len 32768
```

### Kyberion 連携設定

```bash
export KYBERION_REASONING_BACKEND=vllm
export KYBERION_VLLM_URL=http://localhost:8000/v1
export KYBERION_VLLM_MODEL=Qwen/Qwen2.5-Coder-7B-Instruct
```

---

## 3. LM Studio のセットアップ

### 手順

1. LM Studio アプリを起動。
2. 推奨 GGUF モデル（例: Qwen2.5-Coder または Llama-3.2）を検索してダウンロード。
3. タブメニューから **Local Server** (`<->` アイコン) を開く。
4. ポート `1234` で **Start Server** を実行。

### Kyberion 連携設定

```bash
export KYBERION_REASONING_BACKEND=lmstudio
export KYBERION_LMSTUDIO_URL=http://localhost:1234/v1
export KYBERION_LMSTUDIO_MODEL=qwen2.5-coder-7b-instruct
```

---

## 4. llama.cpp (`llama-server`) のセットアップ

### インストール

```bash
brew install llama.cpp
```

### サーバー起動

```bash
llama-server -m /path/to/model.gguf --port 8080 -c 8192 --host 0.0.0.0
```

### Kyberion 連携設定

```bash
export KYBERION_REASONING_BACKEND=llamacpp
export KYBERION_LLAMACPP_URL=http://localhost:8080/v1
export KYBERION_LLAMACPP_MODEL=custom-llama
```

---

## 5. MLX-LM のセットアップ（Apple Silicon Mac 向け）

### インストール

```bash
pip install mlx-lm
```

### サーバー起動

```bash
python3 -m mlx_lm.server --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit --port 8080
```

### Kyberion 連携設定

```bash
export KYBERION_REASONING_BACKEND=mlx
export KYBERION_MLX_URL=http://localhost:8080/v1
export KYBERION_MLX_MODEL=mlx-community/Qwen2.5-Coder-7B-Instruct-4bit
```

---

## 6. 動作確認とトラブルシューティング

### バックエンドの疎通確認

パイプライン `baseline-check` を実行して導通を確認します:

```bash
pnpm pipeline --input pipelines/baseline-check.json
```

### 役割別ルーティングの確認・変更

```bash
pnpm reasoning:config list
pnpm reasoning:config explain --role subagent
pnpm reasoning:config doctor --json
pnpm reasoning:config bind-role subagent ollama:qwen2.5-coder
pnpm reasoning:config set-fallback --role subagent subagent-local,default-codex,agy-default
```

ユーザー設定は `active/shared/state/reasoning-route-user-config.json` に保存され、schema 検証されます。egress、data tier、spend cap はこの設定では上書きできません。

`doctor` は endpoint、CLI/API の準備状態を確認し、completion token を消費しません。local/OpenAI-compatible runtime の tool access は deny-by-default です。`write_file` や `shell_exec` を有効にする場合は、許可 tool を明示した governed profile を使います。

### 手動 API チェック

```bash
curl http://localhost:11434/v1/models
```
