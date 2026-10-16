"""
main.py — HTTP layer only. Receive, validate, respond.

All conversation state lives in core.py, keyed by session_id.
React generates the session_id once on page load (crypto.randomUUID())
and sends it with every request.

Three ways a job description arrives, all ending at set_job_description():
  - pasted into the JD panel          -> /set-jd
  - uploaded as a .pdf/.docx          -> /upload-jd
  - pasted into the chat box          -> /userchat or /chat-stream,
                                         detected by classify_input
"""
import json

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from schemas import ChatQuestion, JDText
from core import (
    answer_question,
    answer_question_stream,
    set_job_description,
    reset_session,
    session_state,
    read_pdf,
    read_docx,
)

app = FastAPI(title="Vidhi Dixit — portfolio chatbot")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "https://vdportfolio-delta.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_UPLOAD_BYTES = 2 * 1024 * 1024        # 2 MB — plenty for a JD
MAX_JD_CHARS = 50_000


@app.get("/health")
def health():
    """React pings this on mount to start warming the container."""
    return {"status": "ok"}


@app.post("/chat-stream")
def chat_stream_endpoint(payload: ChatQuestion):
    """Streaming chat. Emits NDJSON — one JSON object per line:

        {"type":"token","text":"..."}    a piece of the answer
        {"type":"status","text":"..."}   e.g. "Scoring against X…"
        {"type":"done","role":"..."}     final state for the UI

    NDJSON rather than SSE because it is simpler to read with fetch() and
    needs no EventSource (which cannot POST).
    """
    def generate():
        try:
            for event in answer_question_stream(payload.session_id, payload.question):
                yield json.dumps(event) + "\n"
        except Exception as exc:                 # never leave the stream hanging
            print(f"stream failed: {exc}")
            yield json.dumps({"type": "token",
                              "text": "Something went wrong. Please try again."}) + "\n"
            yield json.dumps({"type": "done", "role": None}) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",          # stop proxies buffering the stream
        },
    )


@app.post("/userchat")
def chat_endpoint(payload: ChatQuestion):
    """Non-streaming chat. Kept so the UI can fall back, and for curl testing."""
    answer = answer_question(payload.session_id, payload.question)
    state = session_state(payload.session_id)
    return {
        "answer": answer,
        "has_jd": bool(state["rawjob_Description"]),
        "role": state["role"],
    }


@app.post("/set-jd")
def set_jd(payload: JDText):
    """A pasted job description, from the Job fit panel."""
    return {
        "message": "JD received",
        "role": set_job_description(payload.session_id, payload.jd_text),
    }


@app.post("/upload-jd")
def upload_jd(session_id: str = Form(...), jd_file: UploadFile = File(...)):
    """An uploaded .pdf or .docx job description.
    session_id arrives as a form field: multipart can't also carry a JSON body."""
    name = (jd_file.filename or "").lower()

    if len(session_id) < 8:
        raise HTTPException(400, "Missing session id.")
    if jd_file.size and jd_file.size > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "That file is too large (2 MB max).")

    try:
        if name.endswith(".pdf"):
            jd_text = read_pdf(jd_file.file)        # .file — a file object, not a path
        elif name.endswith(".docx"):
            jd_text = read_docx(jd_file.file)
        else:
            raise HTTPException(400, "Upload a .pdf or .docx file.")

        if not jd_text.strip():
            raise HTTPException(400, "No readable text found in that file.")
        if len(jd_text) > MAX_JD_CHARS:
            raise HTTPException(400, "That job description is too long.")

        return {
            "message": "JD received",
            "role": set_job_description(session_id, jd_text),
        }

    except HTTPException:
        raise                                       # don't swallow our own 400s
    except Exception as exc:
        raise HTTPException(400, f"Could not read that file: {exc}")


@app.post("/reset")
def reset(session_id: str = Form(...)):
    """Clears one visitor's conversation and JD."""
    reset_session(session_id)
    return {"message": "Conversation cleared"}