"""Your slide library: reading PDFs, turning slides into vectors, and searching them.

Each slide is one "chunk". For a course (a few thousand slides at most) a numpy
matrix is plenty fast, so slides don't need a vector database. Search mixes
meaning (embeddings) with exact keyword matches, because embedding models often
miss acronyms like "LoRA" or "KV cache".
"""
from __future__ import annotations

import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

import numpy as np

from . import config, llm

LIBRARY_FILE = config.DATA_DIR / "library.json"
_lock = threading.RLock()
_pdf_lock = threading.Lock()   # the PDF library isn't thread-safe: read one PDF at a time

# In-memory search index, rebuilt whenever a deck finishes or is removed
_index = {"vectors": None, "rows": []}


# --------------------------------------------------------------- library ---

def _load() -> dict:
    if LIBRARY_FILE.exists():
        return json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
    return {"decks": {}}


def _save(lib: dict) -> None:
    tmp = LIBRARY_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(lib, indent=2), encoding="utf-8")
    tmp.replace(LIBRARY_FILE)


def _update(deck_id: str, **fields) -> None:
    with _lock:
        lib = _load()
        if deck_id in lib["decks"]:
            lib["decks"][deck_id].update(fields)
            _save(lib)


def deck_dir(deck_id: str) -> Path:
    return config.DECKS_DIR / deck_id


def list_decks() -> list[dict]:
    with _lock:
        decks = list(_load()["decks"].values())
    return sorted(decks, key=lambda d: d.get("added", 0))


def get_deck(deck_id: str) -> dict | None:
    with _lock:
        return _load()["decks"].get(deck_id)


def pretty_name(filename: str) -> str:
    name = Path(filename).stem
    name = re.sub(r"[_\-]+", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:1].upper() + name[1:] if name else "Untitled"


def add_deck(filename: str, data: bytes) -> dict:
    deck_id = uuid.uuid4().hex[:10]
    d = deck_dir(deck_id)
    d.mkdir(parents=True)
    (d / "source.pdf").write_bytes(data)
    deck = {
        "id": deck_id,
        "name": pretty_name(filename),
        "filename": filename,
        "pages": 0,
        "status": "reading",   # reading -> indexing -> ready | error
        "progress": 0.0,
        "error": None,
        "added": time.time(),
    }
    with _lock:
        lib = _load()
        lib["decks"][deck_id] = deck
        _save(lib)
    start_ingest(deck_id)
    return deck


def rename_deck(deck_id: str, name: str) -> None:
    name = name.strip()[:120]
    if name:
        _update(deck_id, name=name)
        rebuild_index()


def delete_deck(deck_id: str) -> None:
    with _lock:
        lib = _load()
        lib["decks"].pop(deck_id, None)
        _save(lib)
    shutil.rmtree(deck_dir(deck_id), ignore_errors=True)
    rebuild_index()


# ------------------------------------------------------------- ingestion ---

def _clean(text: str) -> str:
    text = text.replace("\r", "\n").replace("\x00", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def start_ingest(deck_id: str) -> None:
    threading.Thread(target=_ingest, args=(deck_id,), daemon=True).start()


def _ingest(deck_id: str) -> None:
    import pypdfium2 as pdfium

    d = deck_dir(deck_id)
    try:
        _update(deck_id, status="reading", progress=0.0, error=None)
        pages = []
        with _pdf_lock:
            pdf = pdfium.PdfDocument(str(d / "source.pdf"))
            try:
                n = len(pdf)
                _update(deck_id, pages=n)
                for i in range(n):
                    page = pdf[i]
                    textpage = page.get_textpage()
                    text = _clean(textpage.get_text_range())
                    # Render the slide: a sharp image for the viewer and a small thumbnail
                    width = page.get_width() or 720
                    scale = min(2.2, 1600 / width)
                    img = page.render(scale=scale).to_pil().convert("RGB")
                    textpage.close()
                    page.close()
                    img.save(d / f"page-{i + 1:03d}.png", optimize=True)
                    thumb = img.copy()
                    thumb.thumbnail((360, 360))
                    thumb.save(d / f"thumb-{i + 1:03d}.jpg", quality=82)
                    pages.append({"page": i + 1, "text": text})
                    _update(deck_id, progress=round((i + 1) / n * 0.5, 3))
            finally:
                pdf.close()
        (d / "pages.json").write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")

        _update(deck_id, status="indexing")
        name = get_deck(deck_id)["name"]
        docs = [
            f"{name}, slide {p['page']}: {p['text'] or '(no text on this slide; probably a diagram or image)'}"
            for p in pages
        ]
        vectors = []
        for i in range(0, len(docs), 16):
            vectors.append(llm.embed(docs[i:i + 16]))
            _update(deck_id, progress=round(0.5 + min(1.0, (i + 16) / len(docs)) * 0.5, 3))
        np.save(d / "embeddings.npy", np.vstack(vectors) if vectors else np.zeros((0, 1)))
        (d / "embed_model.txt").write_text(config.EMBED_MODEL, encoding="utf-8")
        _update(deck_id, status="ready", progress=1.0)
    except llm.LLMError as e:
        _update(deck_id, status="error", error=str(e))
    except Exception as e:  # unreadable PDF etc.
        _update(deck_id, status="error", error=f"Couldn't read this PDF ({type(e).__name__}: {e})")
    rebuild_index()


def resume_unfinished() -> None:
    """Called at startup: finish decks that were interrupted, re-index if the embed model changed."""
    for deck in list_decks():
        d = deck_dir(deck["id"])
        model_file = d / "embed_model.txt"
        stale = deck["status"] == "ready" and (
            not model_file.exists() or model_file.read_text(encoding="utf-8").strip() != config.EMBED_MODEL
        )
        if deck["status"] in ("reading", "indexing") or stale:
            start_ingest(deck["id"])


# ---------------------------------------------------------------- search ---

def load_pages(deck_id: str) -> list[dict]:
    f = deck_dir(deck_id) / "pages.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []


def rebuild_index() -> None:
    rows, mats = [], []
    for deck in list_decks():
        if deck["status"] != "ready":
            continue
        d = deck_dir(deck["id"])
        try:
            vecs = np.load(d / "embeddings.npy")
            pages = load_pages(deck["id"])
        except Exception:
            continue
        if len(vecs) != len(pages) or not len(pages):
            continue
        mats.append(vecs)
        for p in pages:
            rows.append({"deck_id": deck["id"], "deck_name": deck["name"], "page": p["page"],
                         "text": p["text"], "lower": p["text"].lower()})
    with _lock:
        _index["vectors"] = np.vstack(mats) if mats else None
        _index["rows"] = rows


_STOP = set("""a an and are as at be but by can do does for from how i if in into is it its me my of on or
so that the their then there these this to was what when where which who why will with you your about
explain slide slides lecture tell show give please more""".split())


def _keywords(query: str) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9\-\+]{1,}", query)
    return sorted({w.lower() for w in words if w.lower() not in _STOP and (len(w) >= 3 or w.isupper())})


def search(query: str, deck_id: str | None = None, k: int = 5) -> list[dict]:
    with _lock:
        vectors, rows = _index["vectors"], _index["rows"]
    if vectors is None or not rows:
        return []
    q = llm.embed([query], kind="query")[0]
    if q.shape[0] != vectors.shape[1]:
        return []
    scores = vectors @ q
    keys = _keywords(query)
    if keys:
        boost = np.array([min(0.15, 0.05 * sum(1 for kw in keys if kw in r["lower"])) for r in rows])
        scores = scores + boost
    if deck_id:
        mask = np.array([r["deck_id"] == deck_id for r in rows])
        scores = np.where(mask, scores, -np.inf)
    order = np.argsort(-scores)[:k]
    return [
        {"deck_id": rows[i]["deck_id"], "deck_name": rows[i]["deck_name"],
         "page": rows[i]["page"], "text": rows[i]["text"], "score": float(scores[i])}
        for i in order if np.isfinite(scores[i])
    ]


def get_slide(deck_id: str, page: int) -> dict | None:
    deck = get_deck(deck_id)
    if not deck:
        return None
    for p in load_pages(deck_id):
        if p["page"] == page:
            return {"deck_id": deck_id, "deck_name": deck["name"], "page": page, "text": p["text"], "score": 1.0}
    return None


def slide_image(deck_id: str, page: int) -> bytes | None:
    f = deck_dir(deck_id) / f"page-{page:03d}.png"
    return f.read_bytes() if f.exists() else None
