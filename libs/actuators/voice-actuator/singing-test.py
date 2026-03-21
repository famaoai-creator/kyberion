import torch
from transformers import pipeline
from datasets import load_dataset
import soundfile as sf
import os
import sys

# SpeechT5 Singing/Rhythmic Test Script

def test_singing():
    print("🚀 Loading Microsoft SpeechT5 for a singing attempt...")
    try:
        synthesiser = pipeline("text-to-speech", "microsoft/speecht5_tts")
        
        # Use a dummy embedding (SpeechT5 requires it)
        speaker_embedding = torch.zeros((1, 512))

        # Lyrics with rhythmic punctuation to simulate singing cadence
        lyrics = [
            "Hap-py... birth-day... to... you...",
            "Hap-py... birth-day... to... you...",
            "Hap-py... birth-day... dear... fa-mao...",
            "Hap-py... birth-day... to... you!"
        ]
        
        full_audio = []
        sampling_rate = 16000

        for line in lyrics:
            print(f"🎵 Singing: {line}")
            speech = synthesiser(line, forward_params={"speaker_embeddings": speaker_embedding})
            full_audio.append(speech["audio"])

        # Concatenate audio segments
        import numpy as np
        final_audio = np.concatenate(full_audio)

        # Save result
        output_wav = "active/shared/tmp/singing_test.wav"
        sf.write(output_wav, final_audio, samplerate=sampling_rate)
        print(f"✅ Singing saved to {output_wav}")

        # Play
        print("🔊 Playing performance...")
        os.system(f"afplay {output_wav}")
        
        return True
    except Exception as e:
        print(f"❌ Error during singing test: {e}")
        return False

if __name__ == "__main__":
    test_singing()
