#!/usr/bin/env python3
"""
Kyberion mlx-embeddings bridge — Apple Silicon text embeddings.

Usage (argv JSON):
  python3 scripts/mlx_embed.py '{"model":"mlx-community/multilingual-e5-large-instruct","texts":["hello"]}'

Output (stdout, last JSON line wins):
  {"vectors": [[...], [...]]}            — one L2-normalized vector per input text
  {"error": "<message>", "install_hint": "<command>"}  — on failure

The TypeScript caller (libs/core/provider/mlx-embedding-backend.ts) scans stdout
from the end for the first parseable JSON line, so progress/log lines are safe.
"""

import json
import os
import sys
from typing import Optional

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MAX_TEXTS = 64
MAX_TEXT_CHARS = 64_000
DEFAULT_MODEL = "mlx-community/multilingual-e5-large-instruct"


def _emit(payload: dict) -> None:
    print(json.dumps(payload))


def _fail(message: str, install_hint: Optional[str] = None) -> None:
    payload = {"error": message}
    if install_hint:
        payload["install_hint"] = install_hint
    _emit(payload)


def _parse_payload(argv: list[str]) -> dict:
    if len(argv) < 2:
        raise ValueError("usage: mlx_embed.py '<json payload>'")
    payload = json.loads(argv[1])
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    model = payload.get("model") or DEFAULT_MODEL
    if not isinstance(model, str):
        raise ValueError("'model' must be a string")
    texts = payload.get("texts")
    if not isinstance(texts, list) or not texts:
        raise ValueError("'texts' must be a non-empty list")
    if len(texts) > MAX_TEXTS:
        raise ValueError(f"'texts' exceeds {MAX_TEXTS} items")
    for text in texts:
        if not isinstance(text, str):
            raise ValueError("every 'texts' item must be a string")
        if len(text) > MAX_TEXT_CHARS:
            raise ValueError(f"text exceeds {MAX_TEXT_CHARS} chars")
    return {"model": model, "texts": texts}


def _embed(model_id: str, texts: list[str]) -> list[list[float]]:
    try:
        from mlx_embeddings.utils import generate, load  # type: ignore
    except ImportError as exc:
        raise RuntimeError("mlx-embeddings package not installed") from exc

    model, tokenizer = load(model_id)
    response = generate(model, tokenizer, texts=texts)
    embeds = getattr(response, "text_embeds", None)
    if embeds is None:
        raise RuntimeError("mlx-embeddings response carries no text_embeds")

    vectors = embeds.tolist() if hasattr(embeds, "tolist") else [list(v) for v in embeds]
    return [
        [float(component) for component in vector]
        for vector in vectors
    ]


def main() -> None:
    try:
        payload = _parse_payload(sys.argv)
    except (ValueError, json.JSONDecodeError) as exc:
        _fail(f"invalid payload: {exc}")
        return

    try:
        vectors = _embed(payload["model"], payload["texts"])
    except RuntimeError as exc:
        message = str(exc)
        hint = (
            "Install mlx-embeddings into the runtime selected by "
            "KYBERION_PYTHON_BIN / KYBERION_PYTHON."
            if "not installed" in message
            else None
        )
        _fail(message, hint)
        return
    except Exception as exc:  # model load / tokenize / forward failures
        _fail(f"embed failed: {exc}")
        return

    if len(vectors) != len(payload["texts"]):
        _fail(f"expected {len(payload['texts'])} vectors, got {len(vectors)}")
        return
    _emit({"vectors": vectors})


if __name__ == "__main__":
    main()
