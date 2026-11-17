"""The self-learning part: what the tutor remembers about you.

After every exchange, a background worker asks the local model what it learned
about you (understood topics, confusions, preferred explanation style, exams)
and adds, updates or deletes memories. Before answering, the most relevant
memories are pulled back into the prompt.

Two backends with the same interface:
  * Mem0Backend    - the Mem0 library, as in Dave Ebbelaar's video, storing
                     memories in a local Qdrant folder (no Docker needed).
  * BuiltinBackend - a ~100 line version of the same idea (extract facts, then
                     ADD/UPDATE/DELETE/NONE), used if Mem0 can't start.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from . import config, llm, prompts

log = logging.getLogger("study-buddy.memory")


def _results(value) -> list[dict]:
    """Mem0 has returned both {"results": [...]} and plain lists across versions."""
    if isinstance(value, dict):
        value = value.get("results", [])
    return list(value or [])


def _clean_item(m: dict) -> dict:
    return {
        "id": str(m.get("id")),
        "memory": m.get("memory") or m.get("text") or "",
        "created_at": m.get("created_at"),
        "updated_at": m.get("updated_at"),
    }


# ------------------------------------------------------------------ Mem0 ---

class Mem0Backend:
    name = "mem0"

    def __init__(self):
        os.environ.setdefault("MEM0_TELEMETRY", "False")
        from mem0 import Memory  # imported here so the app still runs without it

        dims = int(llm.embed(["dimension check"]).shape[1])
        store = config.MEMORY_DIR / "mem0"
        store.mkdir(parents=True, exist_ok=True)
        cfg = {
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "collection_name": "study_buddy_memories",
                    "path": str(store / "qdrant"),
                    "on_disk": True,  # without this Mem0 wipes the folder on start
                    "embedding_model_dims": dims,
                },
            },
            "llm": {
                "provider": "ollama",
                "config": {
                    "model": config.MEMORY_MODEL,
                    "temperature": 0.1,
                    "max_tokens": 1500,
                    "ollama_base_url": config.OLLAMA_URL,
                },
            },
            "embedder": {
                "provider": "ollama",
                "config": {
                    "model": config.EMBED_MODEL,
                    "ollama_base_url": config.OLLAMA_URL,
                    "embedding_dims": dims,
                },
            },
            "history_db_path": str(store / "history.db"),
            "custom_fact_extraction_prompt": prompts.FACT_EXTRACTION,
        }
        self.m = Memory.from_config(cfg)

    def add(self, messages: list[dict], metadata: dict) -> None:
        self.m.add(messages, user_id=config.USER_ID, metadata=metadata)

    def search(self, query: str, limit: int) -> list[dict]:
        return [_clean_item(x) for x in _results(self.m.search(query, user_id=config.USER_ID, limit=limit))]

    def all(self) -> list[dict]:
        return [_clean_item(x) for x in _results(self.m.get_all(user_id=config.USER_ID))]

    def delete(self, memory_id: str) -> None:
        self.m.delete(memory_id)

    def clear(self) -> None:
        self.m.delete_all(user_id=config.USER_ID)


# --------------------------------------------------------------- Builtin ---

class BuiltinBackend:
    """Mem0's two-phase idea in miniature: extract facts, then reconcile with what's stored."""
    name = "builtin"

    def __init__(self):
        self.file = config.MEMORY_DIR / "builtin_memories.json"
        self.lock = threading.RLock()
        self.items: list[dict] = json.loads(self.file.read_text(encoding="utf-8")) if self.file.exists() else []

    def _save(self):
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.items, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.file)

    def _ensure_vectors(self):
        missing = [m for m in self.items if not m.get("vector")]
        if missing:
            vecs = llm.embed([m["memory"] for m in missing])
            for m, v in zip(missing, vecs):
                m["vector"] = v.tolist()

    def _similar(self, text: str, limit: int) -> list[dict]:
        with self.lock:
            self._ensure_vectors()
            if not self.items:
                return []
            mat = np.asarray([m["vector"] for m in self.items], dtype=np.float32)
            items = list(self.items)
        q = llm.embed([text], kind="query")[0]
        if q.shape[0] != mat.shape[1]:
            return []
        order = np.argsort(-(mat @ q))[:limit]
        return [items[i] for i in order]

    def add(self, messages: list[dict], metadata: dict) -> None:
        convo = "\n".join(f"{m['role']}: {m['content']}" for m in messages)
        facts = llm.complete_json("ollama", prompts.FACT_EXTRACTION, f"Input:\n{convo}",
                                  model=config.MEMORY_MODEL).get("facts", [])
        facts = [f.strip() for f in facts if isinstance(f, str) and f.strip()]
        if not facts:
            return

        # Phase 2: compare with the most similar existing memories
        related: dict[str, dict] = {}
        for f in facts:
            for m in self._similar(f, 5):
                related[m["id"]] = m
        # Short ids stop the model from mangling long uuids (Mem0 does the same trick)
        short = {str(i): m["id"] for i, m in enumerate(related.values())}
        existing = [{"id": s, "text": related[real]["memory"]} for s, real in short.items()]
        if existing:
            decision = llm.complete_json(
                "ollama", prompts.MEMORY_UPDATE,
                f"EXISTING MEMORIES:\n{json.dumps(existing)}\n\nNEW FACTS:\n{json.dumps(facts)}",
                model=config.MEMORY_MODEL,
            ).get("memory", [])
        else:
            decision = [{"id": "new", "text": f, "event": "ADD"} for f in facts]

        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        with self.lock:
            by_id = {m["id"]: m for m in self.items}
            for d in decision:
                if not isinstance(d, dict):
                    continue
                event = str(d.get("event", "")).upper()
                text = str(d.get("text", "")).strip()
                real = short.get(str(d.get("id")))
                if event == "ADD" and text and text.lower() not in {m["memory"].lower() for m in self.items}:
                    self.items.append({"id": uuid.uuid4().hex, "memory": text, "created_at": now,
                                       "updated_at": now, "metadata": metadata})
                elif event == "UPDATE" and real in by_id and text:
                    by_id[real].update(memory=text, updated_at=now, vector=None)
                elif event == "DELETE" and real in by_id:
                    self.items = [m for m in self.items if m["id"] != real]
            # an UPDATE can turn one memory into a copy of another; keep only one
            seen, unique = set(), []
            for m in reversed(self.items):
                key = m["memory"].strip().lower()
                if key not in seen:
                    seen.add(key)
                    unique.append(m)
            self.items = unique[::-1]
            self._ensure_vectors()
            self._save()

    def search(self, query: str, limit: int) -> list[dict]:
        return [_clean_item(m) for m in self._similar(query, limit)]

    def all(self) -> list[dict]:
        with self.lock:
            return [_clean_item(m) for m in self.items]

    def delete(self, memory_id: str) -> None:
        with self.lock:
            self.items = [m for m in self.items if m["id"] != memory_id]
            self._save()

    def clear(self) -> None:
        with self.lock:
            self.items = []
            self._save()


# ------------------------------------------------------------ the store ---

class MemoryStore:
    """Starts the backend lazily (Ollama may not be running yet) and runs writes in the background."""

    def __init__(self):
        self.backend = None
        self.note = None
        self.pending = 0
        self.last_error = None
        self._init_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="memory")

    def _ensure(self):
        if self.backend:
            return self.backend
        with self._init_lock:
            if self.backend:
                return self.backend
            if config.MEMORY_BACKEND == "mem0":
                try:
                    self.backend = Mem0Backend()
                    self.note = None
                    return self.backend
                except llm.LLMError:
                    raise
                except Exception as e:
                    self.note = f"Mem0 couldn't start ({type(e).__name__}: {e}). Using the built-in memory."
                    log.warning(self.note)
            self.backend = BuiltinBackend()
            return self.backend

    @property
    def backend_name(self) -> str:
        return self.backend.name if self.backend else config.MEMORY_BACKEND

    def remember_async(self, messages: list[dict], metadata: dict | None = None) -> None:
        # Long answers make memory extraction slow; the gist is enough
        trimmed = [{"role": m["role"], "content": m["content"][:1800]} for m in messages]
        with self._pending_lock:
            self.pending += 1
        self._worker.submit(self._remember, trimmed, metadata or {})

    def _remember(self, messages, metadata):
        try:
            self._ensure().add(messages, metadata)
            self.last_error = None
        except Exception as e:
            self.last_error = str(e)
            log.warning("Memory update failed: %s", e)
        finally:
            with self._pending_lock:
                self.pending -= 1

    def search(self, query: str, limit: int = 6) -> list[dict]:
        try:
            return self._ensure().search(query, limit)
        except Exception as e:
            self.last_error = str(e)
            return []

    def all(self) -> list[dict]:
        try:
            items = self._ensure().all()
        except Exception as e:
            self.last_error = str(e)
            return []
        return sorted(items, key=lambda m: m.get("updated_at") or m.get("created_at") or "", reverse=True)

    def delete(self, memory_id: str) -> None:
        self._ensure().delete(memory_id)

    def clear(self) -> None:
        self._ensure().clear()


store = MemoryStore()
