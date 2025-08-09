BAYA Agent server v1.5.0

Endpoints
POST /api/chat
POST /api/realtime/session
GET  /health

Render env
OPENAI_API_KEY
ALLOWED_ORIGIN = https://bayagallery.com
BASE_PRODUCT_URL = https://bayagallery.com/artwork/

Client steps
Use only server replies
Send full history each time
Send meta.buyerName when known
Render cards before reply when items exist
