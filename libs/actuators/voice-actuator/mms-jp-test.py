import torch
from transformers import VitsModel, VitsTokenizer
import soundfile as sf
import os
import sys

# Generic VITS Japanese TTS Test Script
# Trying a different model ID

def test_vits_japanese():
    # Attempting with a widely available Japanese VITS model
    model_id = "kakao-enterprise/vits-ljs" # LJSpeech is English, but we want Japanese
    # Correcting to a reliable Japanese ID found in recent docs:
    model_id = "facebook/mms-tts-jpn" 
    
    print(f"🚀 Loading model: {model_id}...")
    
    try:
        # If this fails, we will try to use the pipeline API which is more robust to ID variations
        from transformers import pipeline
        
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        # MMS requires setting the language specifically in some versions
        tts = pipeline("text-to-speech", model=model_id, device=device)
        
        text = "こんにちは。日本語の音声テストです。"
        print(f"🎙️ Generating speech: {text}")
        
        output = tts(text)
        
        output_wav = "active/shared/tmp/vits_jp_out.wav"
        sf.write(output_wav, output["audio"], samplerate=output["sampling_rate"])
        
        print(f"✅ Audio saved to {output_wav}")
        os.system(f"afplay {output_wav}")
        return True
        
    except Exception as e:
        print(f"❌ Error during VITS test: {e}")
        return False

if __name__ == "__main__":
    test_vits_japanese()
