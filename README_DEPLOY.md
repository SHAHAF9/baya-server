# BAYA Agent — Human AI Sales v1.3 (memory, anti-repeat, voice)
- Human, non-scripted replies; asks ONE short follow-up; avoids repeating openings.
- Strong memory: name, location (“from …”), room, style, budget.
- Returns `{ reply, items, meta }` for card rendering.
- Voice endpoint: `/api/realtime/session`.

## Render ENV
- OPENAI_API_KEY
- ALLOWED_ORIGIN = https://bayagallery.com
- BASE_PRODUCT_URL = https://bayagallery.com/artwork/

## Bolt
- Use endpoints:
  - POST https://baya-agent.onrender.com/api/chat
  - POST https://baya-agent.onrender.com/api/realtime/session
- Send real `history` array; pass `meta.sessionId` if you keep sessions.
- Do not auto-print a fallback opener; show only server replies.
- If `res.items`, render cards first, then `res.reply`.
