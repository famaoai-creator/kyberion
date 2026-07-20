# Local LLM Runtime Setup & Operating Runbook

This runbook covers the setup, configuration, and operation of supported local LLM runtimes for Kyberion.

## Supported Runtimes & Endpoints

| Runtime           | Backend Mode (`KYBERION_REASONING_BACKEND`) | Default Endpoint URL        | Base Env Var             | Default Model    | Context Window                      |
| ----------------- | ------------------------------------------- | --------------------------- | ------------------------ | ---------------- | ----------------------------------- |
| **Ollama**        | `ollama`                                    | `http://localhost:11434/v1` | `KYBERION_OLLAMA_URL`    | `llama3.2`       | Model registry or explicit value    |
| **vLLM**          | `vllm`                                      | `http://localhost:8000/v1`  | `KYBERION_VLLM_URL`      | `vllm-model`     | Model registry or explicit value    |
| **LM Studio**     | `lmstudio`                                  | `http://localhost:1234/v1`  | `KYBERION_LMSTUDIO_URL`  | `lmstudio-model` | Model registry or explicit value    |
| **llama.cpp**     | `llamacpp`                                  | `http://localhost:8080/v1`  | `KYBERION_LLAMACPP_URL`  | `llama-model`    | Model registry or explicit value    |
| **MLX-LM**        | `mlx`                                       | `http://localhost:8080/v1`  | `KYBERION_MLX_URL`       | `mlx-model`      | Model registry or explicit value    |
| **LocalAI**       | `localai`                                   | `http://localhost:8080/v1`  | `KYBERION_LOCALAI_URL`   | `localai-model`  | Model registry or explicit value    |
| **Generic Local** | `local`                                     | `http://localhost:11434/v1` | `KYBERION_LOCAL_LLM_URL` | `llama3`         | Unknown means no guessed max_tokens |

---

## 1. Ollama Setup

### Installation

- **macOS / Linux**: Download from [ollama.com](https://ollama.com) or run `brew install ollama`.
- **Docker**: `docker run -d -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama`

### Usage

Pull recommended coding or reasoning models:

```bash
ollama pull llama3.2
ollama pull qwen2.5-coder
```

### Kyberion Integration

```bash
export KYBERION_REASONING_BACKEND=ollama
export KYBERION_OLLAMA_URL=http://localhost:11434
export KYBERION_OLLAMA_MODEL=qwen2.5-coder
```

---

## 2. vLLM Setup

### Installation

```bash
pip install vllm
```

### Running Server

```bash
python3 -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-Coder-7B-Instruct \
  --port 8000 \
  --max-model-len 32768
```

### Kyberion Integration

```bash
export KYBERION_REASONING_BACKEND=vllm
export KYBERION_VLLM_URL=http://localhost:8000/v1
export KYBERION_VLLM_MODEL=Qwen/Qwen2.5-Coder-7B-Instruct
```

---

## 3. LM Studio Setup

### Setup

1. Launch LM Studio GUI.
2. Download your preferred GGUF model (e.g. Qwen2.5-Coder or Llama-3.2).
3. Open the **Local Server** tab (`<->` icon).
4. Start the server on port `1234`.

### Kyberion Integration

```bash
export KYBERION_REASONING_BACKEND=lmstudio
export KYBERION_LMSTUDIO_URL=http://localhost:1234/v1
export KYBERION_LMSTUDIO_MODEL=qwen2.5-coder-7b-instruct
```

---

## 4. llama.cpp (`llama-server`) Setup

### Installation

```bash
brew install llama.cpp
```

### Running Server

```bash
llama-server -m /path/to/model.gguf --port 8080 -c 8192 --host 0.0.0.0
```

### Kyberion Integration

```bash
export KYBERION_REASONING_BACKEND=llamacpp
export KYBERION_LLAMACPP_URL=http://localhost:8080/v1
export KYBERION_LLAMACPP_MODEL=custom-llama
```

---

## 5. MLX-LM Setup (Apple Silicon Macs)

### Installation

```bash
pip install mlx-lm
```

### Running Server

```bash
python3 -m mlx_lm.server --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit --port 8080
```

### Kyberion Integration

```bash
export KYBERION_REASONING_BACKEND=mlx
export KYBERION_MLX_URL=http://localhost:8080/v1
export KYBERION_MLX_MODEL=mlx-community/Qwen2.5-Coder-7B-Instruct-4bit
```

---

## 6. Verification & Troubleshooting

### Probe Backend Health

Run `baseline-check` or use Kyberion CLI:

```bash
pnpm pipeline --input pipelines/baseline-check.json
```

### Test OpenAI Endpoint Manually

```bash
curl http://localhost:11434/v1/models
```
