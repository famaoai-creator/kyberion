import sys
import json
import os
import torch
from pathlib import Path

# Style-Bert-VITS2 Voice Bridge
# Real Implementation for Generative TTS

def speak(text, language="JP", voice_model_path="model"):
    # Resolve paths
    model_dir = Path(os.getcwd()) / "libs/actuators/voice-actuator" / voice_model_path
    config_path = model_dir / "config.json"
    style_vec_path = model_dir / "style_vectors.json"
    model_path = list(model_dir.glob("*.safetensors"))[0] if list(model_dir.glob("*.safetensors")) else None

    if not config_path.exists() or not model_path or not style_vec_path.exists():
        # FALLBACK: Use macOS 'say' if model is not found
        os.system(f'say -v Kyoko "{text}"' if language == "JP" else f'say "{text}"')
        return {"status": "fallback_success", "engine": "macOS-say", "reason": "model_incomplete"}

    try:
        from style_bert_vits2.tts_model import TTSModel
        
        # Load Model (using MPS for Mac acceleration if available)
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        
        model = TTSModel(
            model_path=str(model_path),
            config_path=str(config_path),
            style_vec_path=str(style_vec_path),
            device=device
        )

        # Generate Audio
        output_wav = "active/shared/tmp/voice_out.wav"
        model.infer(
            text=text,
            output_path=output_wav,
            language=language
        )

        # Play Audio via afplay (macOS native player)
        os.system(f"afplay {output_wav}")
        
        return {"status": "success", "engine": "Style-Bert-VITS2", "device": device, "wav": output_wav}

    except Exception as e:
        return {"status": "error", "message": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(1)
    
    try:
        input_data = json.loads(sys.argv[1])
        action = input_data.get("action")
        params = input_data.get("params", {})
        
        if action == "speak":
            # Translate 'jp' to 'JP' for the library
            lang = params.get("language", "jp").upper()
            if lang == "JP": lang = "JP" # library specific
            
            result = speak(params.get("text"), lang)
            print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
