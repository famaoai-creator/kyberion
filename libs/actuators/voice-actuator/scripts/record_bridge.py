import sys
import json
import os
import subprocess
from pathlib import Path

# Kyberion Voice Recorder Bridge (macOS focused)
# Captures audio for voice cloning reference.

def record_sample(output_path, duration=10):
    """
    Records a voice sample using macOS native 'sox' or 'ffmpeg' if available,
    otherwise falls back to 'sox' (often installed via brew) or instructions.
    On macOS, 'sox' is the standard for command-line recording.
    """
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    print(f"🎙️ Recording for {duration} seconds...")
    print(f"   Target: {output_path}")
    print("   [Please speak clearly into the microphone...]")

    try:
        # Try 'sox' (requires 'brew install sox')
        # -d: default audio device
        subprocess.run(["sox", "-d", str(out), "trim", "0", str(duration)], check=True)
        return {"status": "success", "path": str(out), "method": "sox"}
    except FileNotFoundError:
        try:
            # Fallback to 'ffmpeg' (requires 'brew install ffmpeg')
            # -f avfoundation: macOS native framework
            # ":0": default device
            subprocess.run([
                "ffmpeg", "-y", "-f", "avfoundation", "-i", ":0", 
                "-t", str(duration), str(out)
            ], check=True)
            return {"status": "success", "path": str(out), "method": "ffmpeg"}
        except Exception as e:
            return {
                "status": "manual_action_required", 
                "message": "sox or ffmpeg not found. Please record manually.",
                "target_dir": str(out.parent),
                "error": str(e)
            }
    except Exception as e:
        return {"status": "error", "message": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(1)
    
    try:
        input_data = json.loads(sys.argv[1])
        action = input_data.get("action")
        params = input_data.get("params", {})
        
        if action == "record":
            # Default to 10 seconds if not specified
            duration = params.get("duration", 10)
            # Default path if not specified
            output_path = params.get("output_path", "knowledge/personal/voice/samples/ichimura_v1/sample_recorded.wav")
            
            result = record_sample(output_path, duration)
            print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
