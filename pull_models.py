"""Download the Ollama models named in your .env file.   python pull_models.py"""
import json
import sys

import requests

from app import config

models = sorted({config.CHAT_MODEL, config.MEMORY_MODEL, config.EMBED_MODEL})

try:
    requests.get(f"{config.OLLAMA_URL}/api/tags", timeout=3).raise_for_status()
except Exception:
    sys.exit("Ollama isn't running. Install it from https://ollama.com, open it, then run this again.")

for model in models:
    print(f"\nDownloading {model}")
    with requests.post(f"{config.OLLAMA_URL}/api/pull", json={"model": model}, stream=True, timeout=None) as r:
        last = ""
        for line in r.iter_lines():
            if not line:
                continue
            msg = json.loads(line)
            if msg.get("error"):
                sys.exit(f"  Failed: {msg['error']}\n  Check the model name at https://ollama.com/library")
            status = msg.get("status", "")
            if msg.get("total"):
                pct = 100 * msg.get("completed", 0) / msg["total"]
                print(f"\r  {status} {pct:5.1f}%   ", end="", flush=True)
            elif status != last:
                print(f"\r  {status}".ljust(60), flush=True)
            last = status
    print(f"\r  {model} is ready".ljust(60))

print("\nAll models downloaded.")
