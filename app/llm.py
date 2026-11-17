"""Talking to the models: local Ollama and the free Gemini API.

Everything here is plain HTTP with `requests`, so you can read exactly what is
sent. Two providers, same interface:
    stream_chat(provider, system, messages, images) -> yields text chunks
    complete_json(provider, system, prompt)         -> dict
    embed(texts, kind)                              -> numpy array (normalised)
"""
from __future__ import annotations

import base64
import json
import re
import time
from typing import Iterable, Iterator

import numpy as np
import requests

from . import config


class LLMError(Exception):
    """An error with a message that is safe to show in the UI."""


# ---------------------------------------------------------------- Ollama ---

_capabilities: dict[str, list[str]] = {}


def ollama_status() -> dict:
    """Is Ollama running, and are the models we need downloaded?"""
    try:
        r = requests.get(f"{config.OLLAMA_URL}/api/tags", timeout=3)
        r.raise_for_status()
        names = {m.get("name", "") for m in r.json().get("models", [])}
    except Exception:
        return {"running": False, "missing": [], "models": []}

    def have(model: str) -> bool:
        if model in names:
            return True
        # "nomic-embed-text" is stored as "nomic-embed-text:latest"
        return ":" not in model and f"{model}:latest" in names

    needed = {config.CHAT_MODEL, config.MEMORY_MODEL, config.EMBED_MODEL}
    return {
        "running": True,
        "missing": sorted(m for m in needed if not have(m)),
        "models": sorted(names),
    }


def model_sees_images(model: str) -> bool:
    """Ask Ollama whether a model can read images (cached)."""
    if model not in _capabilities:
        try:
            r = requests.post(f"{config.OLLAMA_URL}/api/show", json={"model": model}, timeout=10)
            r.raise_for_status()
            _capabilities[model] = r.json().get("capabilities", []) or []
        except Exception:
            return False
    return "vision" in _capabilities[model]


def _ollama_error(r: requests.Response, model: str) -> LLMError:
    try:
        msg = r.json().get("error", r.text)
    except Exception:
        msg = r.text
    if "not found" in msg.lower():
        return LLMError(f"The model {model} isn't downloaded yet. Run `ollama pull {model}` in a terminal.")
    return LLMError(f"Ollama error: {msg[:300]}")


def _ollama_post(path: str, payload: dict, stream: bool = False, timeout: float = 600):
    try:
        r = requests.post(f"{config.OLLAMA_URL}{path}", json=payload, stream=stream, timeout=timeout)
    except requests.ConnectionError:
        raise LLMError("Ollama isn't running. Open the Ollama app, then try again.")
    if r.status_code != 200:
        raise _ollama_error(r, payload.get("model", ""))
    return r


def _ollama_messages(system: str, messages: list[dict], images: list[bytes] | None) -> list[dict]:
    out = [{"role": "system", "content": system}]
    for m in messages:
        out.append({"role": m["role"], "content": m["content"]})
    if images and out[-1]["role"] == "user":
        out[-1]["images"] = [base64.b64encode(b).decode() for b in images]
    return out


def _stream_ollama(system, messages, images) -> Iterator[str]:
    payload = {
        "model": config.CHAT_MODEL,
        "messages": _ollama_messages(system, messages, images),
        "stream": True,
        "options": {"num_ctx": config.NUM_CTX, "temperature": 0.4},
    }
    r = _ollama_post("/api/chat", payload, stream=True)
    with r:
        for line in r.iter_lines():
            if not line:
                continue
            data = json.loads(line)
            if data.get("error"):
                raise LLMError(f"Ollama error: {data['error']}")
            # Thinking models send their reasoning in a separate field; we skip it.
            chunk = (data.get("message") or {}).get("content", "")
            if chunk:
                yield chunk
            if data.get("done"):
                break


# ---------------------------------------------------------------- Gemini ---

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


def _gemini_contents(messages: list[dict], images: list[bytes] | None) -> list[dict]:
    """One user turn holding the recent conversation as a transcript.

    Newer Gemini models expect earlier model turns to carry "thought signatures",
    which we don't keep. A transcript works on every Gemini version.
    """
    *earlier, last = messages
    text = last["content"]
    if earlier:
        transcript = "\n\n".join(
            f"{'Tutor' if m['role'] == 'assistant' else 'Student'}: {m['content']}" for m in earlier
        )
        text = f"Our conversation so far:\n{transcript}\n\nStudent's new message:\n{text}"
    parts = [{"text": text}]
    for b in images or []:
        parts.append({"inline_data": {"mime_type": "image/png", "data": base64.b64encode(b).decode()}})
    return [{"role": "user", "parts": parts}]


def _gemini_error(r: requests.Response) -> LLMError:
    if r.status_code == 404:
        return LLMError(f"Gemini doesn't know the model \"{config.GEMINI_MODEL}\". "
                        "Set GEMINI_MODEL in .env to a current model name.")
    if r.status_code == 429:
        return LLMError("You've used up Gemini's free limit for now. Switch to Local, or try again later.")
    if r.status_code in (400, 403) and "API key" in r.text:
        return LLMError("Gemini rejected the API key. Check GEMINI_API_KEY in your .env file.")
    try:
        msg = r.json()["error"]["message"]
    except Exception:
        msg = r.text
    return LLMError(f"Gemini error ({r.status_code}): {msg[:300]}")


def _gemini_post(action: str, body: dict, stream: bool, key: str | None = None):
    key = key or config.GEMINI_API_KEY
    if not key:
        raise LLMError("Connect Gemini first: click Gemini at the top and paste your free API key.")
    url = f"{GEMINI_BASE}/{config.GEMINI_MODEL}:{action}"
    if stream:
        url += "?alt=sse"
    try:
        r = requests.post(
            url, json=body, stream=stream, timeout=600,
            headers={"x-goog-api-key": key},
        )
    except requests.ConnectionError:
        raise LLMError("Couldn't reach Gemini. Check your internet connection, or switch to Local.")
    if r.status_code != 200:
        raise _gemini_error(r)
    return r


def _gemini_text(data: dict) -> str:
    parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    return "".join(p.get("text", "") for p in parts if not p.get("thought"))


def _stream_gemini(system, messages, images) -> Iterator[str]:
    body = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": _gemini_contents(messages, images),
    }
    r = _gemini_post("streamGenerateContent", body, stream=True)
    with r:
        for line in r.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            text = _gemini_text(json.loads(line[5:]))
            if text:
                yield text


def check_gemini_key(key: str) -> str | None:
    """Try a key with a tiny request. Returns None if it works, else a message for the user."""
    body = {"contents": [{"role": "user", "parts": [{"text": "Reply with the word OK."}]}]}
    try:
        _gemini_post("generateContent", body, stream=False, key=key)
    except LLMError as e:
        if "free limit" in str(e):
            return None  # the key is valid, it's just out of quota right now
        if "rejected the API key" in str(e) or "error (400)" in str(e) or "error (403)" in str(e):
            return "That key didn't work. Copy it again from Google AI Studio and make sure it's complete."
        return str(e)
    return None


# ----------------------------------------------------------- shared API ---

class _ThinkFilter:
    """Removes <think>...</think> blocks that some local models print inline."""

    def __init__(self):
        self.buf = ""
        self.inside = False

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        out = ""
        while True:
            if self.inside:
                end = self.buf.find("</think>")
                if end < 0:
                    self.buf = self.buf[-8:]
                    return out
                self.buf = self.buf[end + 8:]
                self.inside = False
            else:
                start = self.buf.find("<think>")
                if start < 0:
                    # keep a possible partial "<think" tag for the next chunk
                    keep = 0
                    for n in range(1, 7):
                        if self.buf.endswith("<think>"[:n]):
                            keep = n
                    out += self.buf[: len(self.buf) - keep]
                    self.buf = self.buf[len(self.buf) - keep:]
                    return out
                out += self.buf[:start]
                self.buf = self.buf[start + 7:]
                self.inside = True

    def flush(self) -> str:
        rest, self.buf = ("" if self.inside else self.buf), ""
        return rest


def stream_chat(provider: str, system: str, messages: list[dict],
                images: list[bytes] | None = None) -> Iterator[str]:
    raw = _stream_gemini(system, messages, images) if provider == "gemini" \
        else _stream_ollama(system, messages, images)
    f = _ThinkFilter()
    for chunk in raw:
        text = f.feed(chunk)
        if text:
            yield text
    tail = f.flush()
    if tail:
        yield tail


def _parse_json(text: str) -> dict:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.S)
        if match:
            return json.loads(match.group(0))
        raise LLMError("The model didn't return valid JSON. Try again.")


def complete_json(provider: str, system: str, prompt: str, model: str | None = None) -> dict:
    if provider == "gemini":
        body = {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json"},
        }
        r = _gemini_post("generateContent", body, stream=False)
        return _parse_json(_gemini_text(r.json()))

    payload = {
        "model": model or config.CHAT_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "stream": False,
        "format": "json",
        "options": {"num_ctx": config.NUM_CTX, "temperature": 0.2},
    }
    r = _ollama_post("/api/chat", payload)
    return _parse_json((r.json().get("message") or {}).get("content", ""))


def embed(texts: Iterable[str], kind: str = "document") -> np.ndarray:
    """Embed texts with the local embedding model. Rows are L2-normalised."""
    texts = list(texts)
    if not texts:
        return np.zeros((0, 0), dtype=np.float32)
    # nomic-embed-text was trained with these task prefixes
    if "nomic" in config.EMBED_MODEL:
        prefix = "search_query: " if kind == "query" else "search_document: "
        texts = [prefix + t for t in texts]
    vectors = []
    for i in range(0, len(texts), 16):
        batch = [t[:6000] for t in texts[i:i + 16]]
        for attempt in range(3):
            try:
                r = _ollama_post("/api/embed", {"model": config.EMBED_MODEL, "input": batch}, timeout=300)
                vectors.extend(r.json()["embeddings"])
                break
            except LLMError:
                raise
            except Exception:
                if attempt == 2:
                    raise LLMError("Embedding failed. Is Ollama running?")
                time.sleep(1.5)
    arr = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    return arr / np.maximum(norms, 1e-8)
