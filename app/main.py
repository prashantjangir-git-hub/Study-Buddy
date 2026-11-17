"""The web server. Run with:  python run.py"""
from __future__ import annotations

import json
import logging
import random
import re
from contextlib import asynccontextmanager
from pathlib import Path

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import config, llm, prompts, slides
from .memory import store as memory

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
STATIC = config.ROOT / "static"


def err(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


# ---------------------------------------------------------------- status ---

async def status(request: Request):
    config.refresh_env()
    o = await run_in_threadpool(llm.ollama_status)
    return JSONResponse({
        "ollama": o,
        "chat_model": config.CHAT_MODEL,
        "embed_model": config.EMBED_MODEL,
        "gemini": {"configured": bool(config.GEMINI_API_KEY), "model": config.GEMINI_MODEL},
        "memory": {"backend": memory.backend_name, "note": memory.note, "error": memory.last_error},
    })


async def gemini_settings(request: Request):
    """Connect (validate + save) or disconnect a Gemini API key from the app."""
    body = await request.json()
    if body.get("remove"):
        config.save_env("GEMINI_API_KEY", "")
        config.GEMINI_API_KEY = ""
        return JSONResponse({"configured": False})
    key = re.sub(r"\s+", "", body.get("key") or "")
    if len(key) < 20:
        return err("Paste the whole API key. It's a long string of letters and numbers.")
    problem = await run_in_threadpool(llm.check_gemini_key, key)
    if problem:
        return err(problem)
    config.save_env("GEMINI_API_KEY", key)
    config.GEMINI_API_KEY = key
    return JSONResponse({"configured": True, "model": config.GEMINI_MODEL})


# ----------------------------------------------------------------- decks ---

async def decks_list(request: Request):
    return JSONResponse({"decks": slides.list_decks()})


async def decks_upload(request: Request):
    form = await request.form()
    added, rejected = [], []
    for f in form.getlist("files"):
        if not hasattr(f, "filename"):
            continue
        name = f.filename or "slides.pdf"
        data = await f.read()
        if not data.startswith(b"%PDF"):
            hint = " Export it as PDF from PowerPoint or Google Slides first." if name.lower().endswith((".ppt", ".pptx")) else ""
            rejected.append(f"{name} isn't a PDF.{hint}")
            continue
        added.append(await run_in_threadpool(slides.add_deck, name, data))
    return JSONResponse({"added": added, "rejected": rejected})


async def deck_pages(request: Request):
    deck_id = request.path_params["deck_id"]
    deck = slides.get_deck(deck_id)
    if not deck:
        return err("Deck not found", 404)
    pages = [{"page": p["page"], "has_text": bool(p["text"])} for p in slides.load_pages(deck_id)]
    return JSONResponse({"deck": deck, "pages": pages})


async def deck_update(request: Request):
    deck_id = request.path_params["deck_id"]
    if not slides.get_deck(deck_id):
        return err("Deck not found", 404)
    if request.method == "DELETE":
        await run_in_threadpool(slides.delete_deck, deck_id)
        return JSONResponse({"ok": True})
    body = await request.json()
    if body.get("name"):
        await run_in_threadpool(slides.rename_deck, deck_id, body["name"])
    if body.get("retry"):
        slides.start_ingest(deck_id)
    return JSONResponse({"deck": slides.get_deck(deck_id)})


async def deck_image(request: Request):
    deck_id = request.path_params["deck_id"]
    fname = request.path_params["fname"]
    if not re.fullmatch(r"[0-9a-f]{10}", deck_id) or not re.fullmatch(r"(page-\d{3}\.png|thumb-\d{3}\.jpg)", fname):
        return Response(status_code=404)
    path = slides.deck_dir(deck_id) / fname
    if not path.exists():
        return Response(status_code=404)
    return FileResponse(path, headers={"Cache-Control": "max-age=86400"})


# ------------------------------------------------------------------ chat ---

def _format_sources(sources: list[dict], per_slide: int) -> str:
    if not sources:
        return "(No slides uploaded yet, or none match. Answer from general knowledge and say so.)"
    blocks = []
    for i, s in enumerate(sources, 1):
        text = s["text"] or "(no text: the slide is mostly a diagram or image)"
        blocks.append(f"[S{i}] {s['deck_name']}, slide {s['page']}:\n{text[:per_slide]}")
    return "\n\n".join(blocks)


def _format_memories(mems: list[dict]) -> str:
    if not mems:
        return "(Nothing yet. You're just getting to know them.)"
    return "\n".join(f"- {m['memory']}" for m in mems)


def _source_card(s: dict) -> dict:
    return {"deck_id": s["deck_id"], "deck_name": s["deck_name"], "page": s["page"]}


def _ndjson(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode()


def _prepare_chat(body: dict):
    """Collect slides, memories and images for one chat turn. Runs in a worker thread."""
    provider = "gemini" if body.get("provider") == "gemini" else "ollama"
    message = (body.get("message") or "").strip()
    deck_id = body.get("deck_id") or None
    focus = body.get("focus") or None          # {"deck_id", "page"} from "Explain this slide"
    action = body.get("action")                # "summary" or None
    history = [m for m in (body.get("history") or [])[-8:]
               if m.get("role") in ("user", "assistant") and m.get("content")]

    budget = 60000 if provider == "gemini" else 14000  # characters of slide text
    sources: list[dict] = []
    if action == "summary" and deck_id:
        deck = slides.get_deck(deck_id)
        if not deck or deck["status"] != "ready":
            raise llm.LLMError("That lecture isn't ready yet. Wait for it to finish reading.")
        pages = [p for p in slides.load_pages(deck_id) if p["text"]]
        per = max(200, budget // max(1, len(pages)))
        sources = [{"deck_id": deck_id, "deck_name": deck["name"], "page": p["page"], "text": p["text"][:per]}
                   for p in pages]
        message = prompts.SUMMARY_REQUEST.format(deck=deck["name"])
        per_slide = per
    else:
        if focus:
            s = slides.get_slide(focus["deck_id"], int(focus["page"]))
            if s:
                sources.append(s)
        query = message
        if history and len(message) < 60:      # short follow-ups ("why?") need context
            query = history[-1]["content"][-400:] + "\n" + message
        for s in slides.search(query, deck_id=deck_id, k=5):
            if not any(x["deck_id"] == s["deck_id"] and x["page"] == s["page"] for x in sources):
                sources.append(s)
        # drop weak matches so "hi" doesn't drag in random slides
        best = max((s.get("score", 0) for s in sources), default=0)
        sources = [s for s in sources if s.get("score", 0) >= max(0.25, best - 0.12)][:5]
        per_slide = 2500

    mems = memory.search(message, limit=6)

    # Let the model look at slides that are mostly pictures (diagrams, plots), or the one you asked about
    images = []
    can_see = provider == "gemini" or llm.model_sees_images(config.CHAT_MODEL)
    if can_see and action != "summary":
        for i, s in enumerate(sources):
            if (focus and i == 0) or (len(s["text"]) < 250 and s.get("score", 0) > 0.35):
                img = slides.slide_image(s["deck_id"], s["page"])
                if img:
                    images.append(img)
            if len(images) >= 2:
                break

    system = prompts.TUTOR.format(memories=_format_memories(mems),
                                  sources=_format_sources(sources, per_slide))
    messages = history + [{"role": "user", "content": message}]
    return provider, system, messages, images, sources


async def chat(request: Request):
    body = await request.json()
    if not (body.get("message") or "").strip() and body.get("action") != "summary":
        return err("Type a question first.")

    def generate():
        answer = []
        try:
            provider, system, messages, images, sources = _prepare_chat(body)
            yield _ndjson({"type": "sources", "sources": [_source_card(s) for s in sources]})
            for chunk in llm.stream_chat(provider, system, messages, images):
                answer.append(chunk)
                yield _ndjson({"type": "token", "text": chunk})
        except llm.LLMError as e:
            yield _ndjson({"type": "error", "message": str(e)})
            return
        except Exception as e:
            logging.exception("chat failed")
            yield _ndjson({"type": "error", "message": f"Something went wrong: {e}"})
            return
        text = "".join(answer).strip()
        if text and body.get("action") != "summary":
            memory.remember_async(
                [{"role": "user", "content": body["message"]}, {"role": "assistant", "content": text}],
                {"source": "chat"},
            )
        yield _ndjson({"type": "done", "learning": bool(text and body.get("action") != "summary")})

    return StreamingResponse(generate(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ quiz ---

def _make_quiz(body: dict) -> dict:
    provider = "gemini" if body.get("provider") == "gemini" else "ollama"
    mode = body.get("mode", "deck")
    deck_id = body.get("deck_id") or None
    count = max(3, min(8, int(body.get("count", 5))))
    hint = ""

    if mode == "weak":
        weak = memory.search("struggles with, confused about, got wrong, mistakes, weak topics", limit=8)
        if not weak:
            raise llm.LLMError("I don't know your weak spots yet. Chat about a few topics or take a quiz first.")
        hint = prompts.QUIZ_WEAK_HINT.format(memories=_format_memories(weak))
        sources, seen = [], set()
        for m in weak:
            for s in slides.search(m["memory"], deck_id=deck_id, k=2):
                key = (s["deck_id"], s["page"])
                if key not in seen:
                    seen.add(key)
                    sources.append(s)
        sources = sources[:10]
    else:
        decks = [slides.get_deck(deck_id)] if deck_id else [d for d in slides.list_decks() if d["status"] == "ready"]
        pool = []
        for d in decks:
            if d:
                pool += [{"deck_id": d["id"], "deck_name": d["name"], "page": p["page"], "text": p["text"]}
                         for p in slides.load_pages(d["id"]) if len(p["text"]) > 80]
        if not pool:
            raise llm.LLMError("Add some lecture PDFs first, then I can quiz you on them.")
        sources = sorted(random.sample(pool, min(10, len(pool))), key=lambda s: (s["deck_name"], s["page"]))

    if not sources:
        raise llm.LLMError("I couldn't find slides about your weak topics. Try a normal quiz on a lecture.")
    system = prompts.QUIZ.format(count=count)
    prompt = (hint + "\n\n" if hint else "") + "Slides:\n" + _format_sources(sources, 1200)
    data = llm.complete_json(provider, system, prompt)

    questions = []
    for q in data.get("questions", []):
        try:
            opts = [str(o) for o in q["options"]][:4]
            ans = int(q["answer"])
            if len(opts) < 2 or not 0 <= ans < len(opts):
                continue
            src = None
            m = re.search(r"\d+", str(q.get("source", "")))
            if m and 1 <= int(m.group()) <= len(sources):
                src = _source_card(sources[int(m.group()) - 1])
            questions.append({"question": str(q["question"]), "options": opts, "answer": ans,
                              "explanation": str(q.get("explanation", "")), "source": src})
        except (KeyError, ValueError, TypeError):
            continue
    if not questions:
        raise llm.LLMError("The quiz came back empty. Try again.")
    return {"questions": questions[:count]}


async def quiz(request: Request):
    body = await request.json()
    try:
        return JSONResponse(await run_in_threadpool(_make_quiz, body))
    except llm.LLMError as e:
        return err(str(e))


async def quiz_finish(request: Request):
    """Turn quiz results into memories, e.g. 'Got the question on KV caching wrong'."""
    body = await request.json()
    lines = []
    for r in body.get("results", [])[:10]:
        verdict = "correctly" if r.get("correct") else f"wrongly (picked: {r.get('chosen', '')[:150]})"
        lines.append(f"- Q: {r.get('question', '')[:300]} | answered {verdict} | correct answer: {r.get('answer', '')[:150]}")
    if lines:
        memory.remember_async([{"role": "user", "content": "My quiz results:\n" + "\n".join(lines)}],
                              {"source": "quiz"})
    return JSONResponse({"ok": True, "learning": bool(lines)})


# -------------------------------------------------------------- memories ---

async def memories(request: Request):
    if request.method == "DELETE":
        await run_in_threadpool(memory.clear)
        return JSONResponse({"ok": True})
    items = await run_in_threadpool(memory.all)
    return JSONResponse({"memories": items, "pending": memory.pending,
                         "backend": memory.backend_name, "error": memory.last_error})


async def memory_delete(request: Request):
    await run_in_threadpool(memory.delete, request.path_params["memory_id"])
    return JSONResponse({"ok": True})


# ------------------------------------------------------------------- app ---

async def index(request: Request):
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@asynccontextmanager
async def lifespan(app):
    slides.rebuild_index()
    slides.resume_unfinished()
    yield


app = Starlette(
    routes=[
        Route("/", index),
        Route("/api/status", status),
        Route("/api/settings/gemini", gemini_settings, methods=["POST"]),
        Route("/api/decks", decks_list, methods=["GET"]),
        Route("/api/decks", decks_upload, methods=["POST"]),
        Route("/api/decks/{deck_id}", deck_pages, methods=["GET"]),
        Route("/api/decks/{deck_id}", deck_update, methods=["PATCH", "DELETE"]),
        Route("/slides/{deck_id}/{fname}", deck_image),
        Route("/api/chat", chat, methods=["POST"]),
        Route("/api/quiz", quiz, methods=["POST"]),
        Route("/api/quiz/finish", quiz_finish, methods=["POST"]),
        Route("/api/memories", memories, methods=["GET", "DELETE"]),
        Route("/api/memories/{memory_id}", memory_delete, methods=["DELETE"]),
        Mount("/static", StaticFiles(directory=STATIC), name="static"),
    ],
    lifespan=lifespan,
)
