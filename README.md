# Vidhi Dixit — recruiter chatbot

A FastAPI backend (`backend/`) that answers recruiter questions about Vidhi from a
knowledge base, scores her against a job description, and streams answers as
NDJSON. A React front-end lives in `frontend/`.

- `backend/main.py` — HTTP layer (`/health`, `/chat-stream`, `/userchat`, `/set-jd`, `/upload-jd`, `/reset`)
- `backend/core.py` — knowledge base, parsers, scoring tool, per-session state
- `backend/llm.py` — OpenAI as primary, Groq as automatic fallback
- `backend/Resume/` — the knowledge base `.docx`. Required: the app raises at startup without it.

## Run locally

```
cd backend
cp .env.example .env        # then fill in the keys
pip install -r requirements.txt
uvicorn main:app --reload
```

## Knowledge base cache — `parsed_resume.json`

`backend/parsed_resume.json` is a cached structured parse of the knowledge base
(~16k tokens of input to produce). It is committed so that Render, whose
filesystem is ephemeral, does not re-pay that parse on every cold start.

**Whenever the knowledge base `.docx` changes, delete `parsed_resume.json`,
start the app once locally to regenerate it, and commit the new file.**
Otherwise the cache silently describes the old knowledge base.

## Deploy to Render

Create a **Web Service** from this repository with these settings:

| Setting | Value |
|---|---|
| Runtime | Python 3 |
| Root Directory | `backend` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1` |
| Instance Type | Free |
| Health Check Path | `/health` |

Environment variables:

| Key | Value |
|---|---|
| `OPENAI_API_KEY` | your OpenAI key (primary) |
| `GROQ_API_KEY` | your Groq key (fallback) |
| `PYTHON_VERSION` | `3.13.9` |

Notes:

- **`--workers 1` is mandatory.** Session state (conversation history and the
  job description) lives in a dict in process memory. With more than one
  worker, consecutive requests from the same visitor can land in different
  processes and lose their session.
- **The free tier sleeps after ~15 minutes idle**, so the first request after a
  sleep can take 30–50 seconds. The front-end pings `/health` on page load to
  start waking the service early.
- `.env` is not committed. Set the keys in Render's Environment tab.
- CORS allows `https://vdportfolio-delta.vercel.app` and local dev origins
  (`backend/main.py`). Add any other front-end origin there.
- The front-end reads the backend URL from `VITE_API_URL`; set it to the Render
  service URL in the front-end's hosting settings.
