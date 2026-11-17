"""All settings live in the .env file next to README.md. Defaults work out of the box."""
import os
from pathlib import Path

from dotenv import dotenv_values, load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _get(name: str, default: str) -> str:
    value = os.getenv(name, "").strip()
    return value or default


# Where your slides, images and memories are stored on disk
DATA_DIR = Path(_get("DATA_DIR", str(ROOT / "data"))).resolve()
DECKS_DIR = DATA_DIR / "decks"
MEMORY_DIR = DATA_DIR / "memory"
for _d in (DATA_DIR, DECKS_DIR, MEMORY_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# Local models (Ollama)
OLLAMA_URL = _get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
CHAT_MODEL = _get("CHAT_MODEL", "gemma4:e4b")          # explains things to you
MEMORY_MODEL = _get("MEMORY_MODEL", CHAT_MODEL)         # decides what to remember about you
EMBED_MODEL = _get("EMBED_MODEL", "nomic-embed-text")   # turns slides into vectors for search
NUM_CTX = int(_get("NUM_CTX", "8192"))                  # how much text the local model can read at once

# Free Gemini API (optional). Get a key at https://aistudio.google.com/apikey
GEMINI_API_KEY = _get("GEMINI_API_KEY", "")
GEMINI_MODEL = _get("GEMINI_MODEL", "gemini-flash-latest")

# "mem0" uses the Mem0 library (like the video). "builtin" uses the small
# Mem0-style memory in app/memory.py. If Mem0 fails to start, builtin is used.
MEMORY_BACKEND = _get("MEMORY_BACKEND", "mem0").lower()
USER_ID = _get("USER_ID", "me")

HOST = _get("HOST", "127.0.0.1")
PORT = int(_get("PORT", "8000"))


ENV_FILE = ROOT / ".env"


def refresh_env() -> None:
    """Re-read the Gemini settings from .env, so editing the file works without a restart."""
    global GEMINI_API_KEY, GEMINI_MODEL
    if ENV_FILE.exists():
        values = dotenv_values(ENV_FILE)
        GEMINI_API_KEY = (values.get("GEMINI_API_KEY") or "").strip()
        GEMINI_MODEL = (values.get("GEMINI_MODEL") or "").strip() or "gemini-flash-latest"


def save_env(name: str, value: str) -> None:
    """Set NAME=value in .env, keeping every other line as it is."""
    if not ENV_FILE.exists():
        example = ROOT / ".env.example"
        ENV_FILE.write_text(example.read_text(encoding="utf-8") if example.exists() else "", encoding="utf-8")
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        if line.split("=", 1)[0].strip() == name:
            lines[i] = f"{name}={value}"
            break
    else:
        lines.append(f"{name}={value}")
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
