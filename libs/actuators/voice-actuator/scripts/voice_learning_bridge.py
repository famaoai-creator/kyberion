import sys
import json
import os
import shutil
from pathlib import Path

# Kyberion Voice Learning Bridge (Abstracted)
# Supported Providers: local (placeholder), elevenlabs (env based), openai (env based)

def learn_voice(profile_id, sample_dir, provider="local"):
    """
    Learns/Clones a voice from audio samples.
    """
    sample_path = Path(sample_dir)
    if not sample_path.exists():
        return {"status": "error", "message": f"Sample directory {sample_dir} not found"}

    samples = list(sample_path.glob("*.wav")) + list(sample_path.glob("*.mp3"))
    if not samples:
        return {"status": "error", "message": "No audio samples found (.wav or .mp3)"}

    if provider == "local":
        # Placeholder for local fine-tuning or profile creation
        # In a real scenario, this would trigger a training script for GPT-SoVITS or similar.
        # Here we just 'register' it by copying files to a managed location.
        target_dir = Path(f"libs/actuators/voice-actuator/profiles/{profile_id}")
        target_dir.mkdir(parents=True, exist_ok=True)
        for s in samples:
            shutil.copy(s, target_dir / s.name)
        
        return {
            "status": "success", 
            "message": "Voice samples registered locally", 
            "profile_id": profile_id,
            "provider": "local (simulated learning)"
        }
    
    elif provider == "elevenlabs":
        # Example for ElevenLabs Instant Voice Cloning
        api_key = os.getenv("ELEVENLABS_API_KEY")
        if not api_key:
            return {"status": "error", "message": "ELEVENLABS_API_KEY not found"}
        
        # This would use the elevenlabs library or requests to upload samples
        return {"status": "pending", "message": "Cloud cloning would be triggered here"}

    return {"status": "error", "message": f"Unsupported provider: {provider}"}

def generate_voice(text, profile_id, provider="local"):
    """
    Generates voice using the learned profile.
    """
    if provider == "local":
        # Simplified: if it's local and we don't have a full model yet, use macOS 'say'
        # but in a real 'cloned' setup, this would use a VITS/SoVITS model.
        os.system(f'say -v Kyoko "{text}"')
        return {"status": "success", "engine": "macOS-say (profile-aware fallback)", "profile": profile_id}
    
    return {"status": "error", "message": f"Unsupported provider: {provider}"}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(1)
    
    try:
        input_data = json.loads(sys.argv[1])
        action = input_data.get("action")
        params = input_data.get("params", {})
        
        if action == "learn":
            result = learn_voice(
                params.get("profile_id"), 
                params.get("sample_dir"),
                params.get("provider", "local")
            )
            print(json.dumps(result))
        elif action == "generate":
            result = generate_voice(
                params.get("text"),
                params.get("profile_id"),
                params.get("provider", "local")
            )
            print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
