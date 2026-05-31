import sys
import json
import os
import shutil
import subprocess
from pathlib import Path

# Kyberion Voice Recorder Bridge (macOS focused)
# Captures audio for voice cloning reference.

import time

def record_sample(output_path, duration=10):
    """
    Records a voice sample using macOS native 'sox' or 'ffmpeg' in a background
    process with a highly responsive, high-fidelity console countdown progress bar.
    """
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    print(f"\n🎙️  マイク初期化中 (Initializing default audio interface...)\n")
    print(f"   保存先: {output_path}\n")

    # Probe recording command
    cmd = []
    if shutil.which("sox"):
        # Trim 0 duration
        cmd = ["sox", "-d", str(out), "trim", "0", str(duration)]
        method = "sox"
    elif shutil.which("ffmpeg"):
        cmd = [
            "ffmpeg", "-y", "-f", "avfoundation", "-i", ":0", 
            "-t", str(duration), str(out)
        ]
        method = "ffmpeg"
    else:
        return {
            "status": "manual_action_required", 
            "message": "sox or ffmpeg not found in path. Please install brew install ffmpeg.",
            "target_dir": str(out.parent)
        }

    try:
        # Spawn recording in the background
        # Redirect stderr/stdout to DEVNULL to avoid cluttered output from ffmpeg/sox
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        # Warm-up delay to let default microphone device settle
        time.sleep(1.0)
        
        print("🔴  【録音開始】マイクに向かってはっきりと読み上げてください！\n")
        
        # Stylized live single-line countdown progress bar
        for i in range(duration, 0, -1):
            bar_width = 30
            filled_len = int(round(bar_width * (duration - i) / duration))
            bar = "█" * filled_len + "░" * (bar_width - filled_len)
            
            # Print carriage return to keep progress updating on a single line
            sys.stdout.write(f"\r    [{bar}] 残り {i:2d} 秒... ")
            sys.stdout.flush()
            time.sleep(1.0)
            
        # Print final full bar
        sys.stdout.write(f"\r    [{'█' * 30}] 残り  0 秒... \n")
        sys.stdout.flush()

        # Wait for the recording process to cleanly wrap up and write the file
        proc.wait(timeout=5)
        
        print(f"\n✅  収録成功！ (Successfully saved to {out.name})\n")
        return {"status": "success", "path": str(out), "method": method}
        
    except subprocess.TimeoutExpired:
        # Gracefully terminate if process hung
        proc.terminate()
        return {"status": "error", "message": "Recording process timed out."}
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
