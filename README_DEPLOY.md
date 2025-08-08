# BAYA Agent — Human AI Sales (Chat + Voice)

**Goal:** Maya feels like a real human consultant. She builds rapport, asks naturally (no form), suggests 1–2 tailored pieces, handles objections, offers 5OFF/10OFF when it helps, and closes gracefully. Links go to `/artwork/{slug}`.

## Environment (Render → *baya-agent*)
- `OPENAI_API_KEY`
- `ALLOWED_ORIGIN = https://bayagallery.com`
- `BASE_PRODUCT_URL = https://bayagallery.com/artwork/`
- (Do **not** set `PORT`)

## Endpoints
- `GET /health` → `ok`
- `POST /api/chat` → `{ reply, items, meta }`
- `POST /api/realtime/session` → returns ephemeral `client_secret` for WebRTC Voice

## Bolt — What happens when clicking **Voice**?
- The page stays on bayagallery.com (no redirect).
- Browser asks for microphone permission.
- Your JS calls `POST https://baya-agent.onrender.com/api/realtime/session` to get a short‑lived `client_secret`.

- A WebRTC peer connection is created, an SDP offer is sent to OpenAI Realtime.

- OpenAI returns an SDP answer, and audio starts streaming to an `<audio>` element — live consult with Maya.

- If permission/HTTPS fails: show a friendly alert and keep chat available.

## Start
npm start
