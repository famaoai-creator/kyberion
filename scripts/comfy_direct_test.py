import json
import urllib.request
import sys

def queue_prompt(prompt_workflow):
    p = {"prompt": prompt_workflow}
    data = json.dumps(p).encode('utf-8')
    req =  urllib.request.Request("http://127.0.0.1:8188/prompt", data=data)
    try:
        with urllib.request.urlopen(req) as f:
            return json.loads(f.read().decode('utf-8'))
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    workflow_path = "active/shared/tmp/temp_vision_workflow.json"
    try:
        with open(workflow_path, 'r') as f:
            workflow = json.load(f)
        
        print(f"🚀 Sending direct prompt to ComfyUI at 127.0.0.1:8188...")
        result = queue_prompt(workflow)
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
