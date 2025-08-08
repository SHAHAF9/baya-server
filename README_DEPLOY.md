# BAYA Agent — Dynamic Sales with Cards (artwork links)

- Links go to `https://bayagallery.com/artwork/{slug}` (no query params).
- `/api/chat` returns `reply` and an `items` array for card rendering.
- Conversation is persuasive and human-like: captures name, discovery → tailored picks → CTA, optional Oct 7 + IDF donation when helpful.
- Coupons: 5OFF / 10OFF offered naturally.

## Environment (Render → baya-agent)
- OPENAI_API_KEY
- ALLOWED_ORIGIN = https://bayagallery.com
- BASE_PRODUCT_URL = https://bayagallery.com/artwork/
