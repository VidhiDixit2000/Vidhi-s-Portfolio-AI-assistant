# Ask Vidhi — frontend

React + Vite single-page app that talks to the FastAPI backend in `../backend`.

## Run locally

```bash
cp .env.example .env      # points at http://127.0.0.1:8000
npm install
npm run dev               # serves on http://localhost:3000
```

Start the backend separately (from `../backend`, e.g. `uvicorn main:app --reload`).
The dev server is pinned to port 3000 because that is the origin the backend's CORS
config allows.

## Environment variables

| name | example | purpose |
|---|---|---|
| `VITE_API_URL` | `https://your-api.onrender.com` | Base URL of the FastAPI backend, no trailing slash. Falls back to `http://127.0.0.1:8000` if unset. |

Vite inlines `VITE_*` variables at **build time**, so changing one requires a rebuild.

## Pointing at the deployed API (Vercel)

1. In the Vercel project, open **Settings → Environment Variables**.
2. Add `VITE_API_URL` set to the Render URL of the backend (e.g. `https://your-api.onrender.com`) for the Production (and Preview, if wanted) environments.
3. Redeploy, since the value is baked into the build.
4. Make sure the Vercel domain is listed in `allow_origins` in `backend/main.py`, or the browser will block the requests.

The backend runs on Render's free tier and sleeps when idle, so the first request after
a quiet spell can take 30–50 seconds. The app pings `/health` on load to start it warming
and shows a "Waking up the assistant" notice if a request takes more than 3 seconds.
