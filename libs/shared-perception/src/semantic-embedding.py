"""Bounded local CLIP / SigLIP image-text embeddings; invoked by semantic-index.ts.

Install torch, transformers and Pillow in an isolated managed Python runtime.
Models must already exist locally as safetensors. No network or remote code.
Language coverage and text context length are properties of the chosen model.
"""
import contextlib
import json
import os
import sys

MAX_INPUT_BYTES = 1024 * 1024
MAX_PIXELS = 16 * 1024 * 1024


def main():
    request_bytes = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(request_bytes) > MAX_INPUT_BYTES:
        raise ValueError("embedding request exceeds 1 MiB")
    request = json.loads(request_bytes)
    inputs = request.get("inputs")
    model_path = request.get("model_path")
    if not isinstance(model_path, str) or not os.path.isdir(model_path):
        raise ValueError("existing local model_path directory required")
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= 32:
        raise ValueError("inputs must contain 1..32 items")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    # Keep provider/library diagnostics off the JSON channel.
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from PIL import Image
        from transformers import AutoConfig, AutoModel, AutoProcessor
        torch.set_num_threads(2)
        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        config = AutoConfig.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
        if config.model_type not in ("clip", "siglip", "siglip2"):
            raise ValueError("only built-in CLIP / SigLIP models are supported")
        model = AutoModel.from_pretrained(model_path, local_files_only=True, trust_remote_code=False, use_safetensors=True)
        model.eval()
        processor = AutoProcessor.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
        max_tokens = min(256, int(getattr(config.text_config, "max_position_embeddings", 77)))
        vectors = []
        with torch.inference_mode():
            for item in inputs:
                if not isinstance(item, dict) or len(item) != 1:
                    raise ValueError("each input must contain exactly text or imagePath")
                if "text" in item:
                    text = item["text"]
                    if not isinstance(text, str) or not 1 <= len(text) <= 16384:
                        raise ValueError("text must contain 1..16384 characters")
                    tokens = processor(text=[text], padding="max_length", truncation=False, max_length=max_tokens, return_tensors="pt")
                    if tokens["input_ids"].shape[1] > max_tokens:
                        raise ValueError("text exceeds the selected model context; split it into shorter entries")
                    features = model.get_text_features(**tokens, return_dict=True)
                elif "imagePath" in item:
                    image_path = item["imagePath"]
                    if not isinstance(image_path, str) or not os.path.isfile(image_path):
                        raise ValueError("existing imagePath required")
                    with Image.open(image_path) as raw:
                        if raw.width * raw.height > MAX_PIXELS:
                            raise ValueError("image exceeds pixel limit")
                        raw.thumbnail((2048, 2048))
                        image = raw.convert("RGB")
                        pixels = processor(images=image, return_tensors="pt")
                        features = model.get_image_features(**pixels, return_dict=True)
                else:
                    raise ValueError("unknown embedding input")
                if not isinstance(features, torch.Tensor):
                    features = features.pooler_output
                if features.ndim != 2 or features.shape[0] != 1 or not 2 <= features.shape[1] <= 4096:
                    raise ValueError("invalid model feature shape")
                features = torch.nn.functional.normalize(features.float(), p=2, dim=-1)
                if not torch.isfinite(features).all().item():
                    raise ValueError("nonfinite embedding")
                vectors.append(features[0].cpu().tolist())
    sys.stdout.write(json.dumps({"vectors": vectors}, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        sys.stderr.write("semantic embedding unavailable: " + str(exc)[:2048] + "\n")
        sys.exit(1)
