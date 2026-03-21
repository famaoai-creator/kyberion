import torch
from transformers import pipeline
from datasets import load_dataset
import soundfile as sf
import os
import sys

# Microsoft SpeechT5 Test Script
# Generates speech using transformers library

def test_ms_voice():
    print("🚀 Loading Microsoft SpeechT5 pipeline...")
    try:
        # 1. Initialize the TTS pipeline
        synthesiser = pipeline("text-to-speech", "microsoft/speecht5_tts")

        # 2. Load speaker embeddings
        # Using a dummy 512-dim vector for testing to avoid dataset issues
        print("💡 Creating dummy speaker embedding...")
        speaker_embedding = torch.zeros((1, 512))

        # 3. Generate speech
        text = "Hello famao. This is a test of Microsoft Speech T 5 running locally on your Mac. How is the audio quality?"
        print(f"🎙️ Generating speech: {text}")
        
        speech = synthesiser(text, forward_params={"speaker_embeddings": speaker_embedding})

        # 4. Save the result
        output_wav = "active/shared/tmp/ms_voice_out.wav"
        sf.write(output_wav, speech["audio"], samplerate=speech["sampling_rate"])
        print(f"✅ Audio saved to {output_wav}")

        # 5. Play Audio
        print("🔊 Playing audio...")
        os.system(f"afplay {output_wav}")
        
        return True
    except Exception as e:
        print(f"❌ Error during MS voice test: {e}")
        return False

if __name__ == "__main__":
    test_ms_voice()
