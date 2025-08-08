import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

/*
 * Simple HTTP server to power the BAYA Gallery sales agent.  This implementation
 * deliberately avoids external dependencies (such as Express or CORS packages)
 * so that it can run in environments without an internet connection.  It
 * exposes a few endpoints:
 *   GET  /health               — health check (returns "ok")
 *   POST /api/chat             — returns artwork recommendations and discount info
 *   POST /api/realtime/session — placeholder for realtime voice integration
 *
 * The server loads a catalog of artworks from a JSON file generated from the
 * Excel workbook.  It uses simple string matching to recommend artworks and
 * offers discounts based on the content of the user's message.
 */

// Locate the catalog JSON relative to this script.  The catalog is loaded
// synchronously during startup.
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const catalogPath = path.resolve(__dirname, '../baya_catalog.json');
let catalog = [];
try {
  const contents = fs.readFileSync(catalogPath, 'utf-8');
  catalog = JSON.parse(contents);
} catch (err) {
  console.error('Failed to load catalog:', err.message);
  catalog = [];
}

// Parse the ALLOWED_ORIGIN environment variable into an array of hosts.  An
// empty array means all origins are allowed.  Origins should be specified
// without trailing slashes and separated by commas.
const allowedOrigins = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  : [];

/**
 * Search the catalog for artworks matching a query.  The algorithm scores
 * matches on the title, artist and search blob.  Higher scores are returned
 * first.  A limited number of results are returned as specified by limit.
 *
 * @param {string} query    The search query provided by the user.
 * @param {number} limit    How many records to return.
 * @returns {Array<Object>} A list of artwork objects.
 */
function searchArtworks(query = '', limit = 3) {
  const q = String(query).toLowerCase().trim();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
  const scored = catalog.map(rec => {
    let score = 0;
    if (tokens.length) {
      const blob = String(rec.search_blob || '').toLowerCase();
      const title = String(rec.title || '').toLowerCase();
      const artist = String(rec.artist || '').toLowerCase();
      tokens.forEach(tok => {
        if (blob.includes(tok)) score += 2;
        if (title.includes(tok)) score += 3;
        if (artist.includes(tok)) score += 3;
      });
    }
    if (rec.main_image) score += 1;
    return { rec, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.rec);
}

/**
 * Determine whether to offer a discount.  The logic inspects the user's
 * message for keywords indicating price sensitivity.  A strong signal (e.g.
 * mention of budget or competitor pricing) yields a 10% coupon; a mild signal
 * (e.g. mention of price or discount) yields a 5% coupon; otherwise no
 * discount is offered.
 *
 * @param {string} message  The user's latest message.
 * @returns {Object|null}    An object { code, percent } or null if no coupon.
 */
function decideCoupon(message = '') {
  const text = String(message || '').toLowerCase();
  // detect mild price sensitivity in English
  const mild = /(price|expensive|discount|coupon|deal|sale)/.test(text);
  // detect strong price signals in English such as explicit budget or competitor references
  const strong = /(too expensive|budget|limit|competitor|if.*price|if.*cost)/.test(text);
  if (strong) return { code: '10OFF', percent: 10 };
  if (mild) return { code: '5OFF', percent: 5 };
  return null;
}

/**
 * Build a checkout URL for the client.  The URL uses environment variables
 * BASE_PRODUCT_URL (should end with a slash) and CHECKOUT_QUERY (should begin
 * with a question mark) to assemble a link.  If a coupon code is provided
 * it is appended as a query parameter `coupon=CODE`.
 *
 * @param {string} slug         The slug of the artwork.
 * @param {string} couponCode   Optional coupon code to append.
 * @returns {string}            A complete URL that can be used in the webapp.
 */
function buildCheckoutUrl(slug, couponCode) {
  const base = process.env.BASE_PRODUCT_URL || 'https://bayagallery.com/art/';
  const query = process.env.CHECKOUT_QUERY || '?buy=1';
  let url = `${base}${encodeURIComponent(slug)}${query}`;
  if (couponCode) {
    url += `&coupon=${encodeURIComponent(couponCode)}`;
  }
  return url;
}

/**
 * Assemble a textual response summarising artwork suggestions along with
 * pricing information and coupon instructions.  This function is used by
 * the chat endpoint to format the JSON reply for the client.
 *
 * @param {Array<Object>} results   List of artwork records.
 * @param {Object|null} discount    Discount information returned by decideCoupon.
 * @returns {string}                 Human‑readable response in English.
 */
function assembleReply(results, discount) {
  let reply = '';
  // If no results, apologise in English
  if (!results.length) {
    return "Sorry, I couldn't find suitable artworks at this time.";
  }
  // Introductory sentence in English
  reply += 'Here are some recommended artworks for you:\n';
  results.forEach((art, idx) => {
    const price = Number(art.price || 0);
    let finalPrice = price;
    // Apply discount if present
    if (discount) {
      finalPrice = Math.round(price * (100 - discount.percent)) / 100;
    }
    // Price description: show final price and mention original price when a discount is applied
    const priceInfo = discount ? `${finalPrice} (instead of ${price})` : `${price}`;
    const url = buildCheckoutUrl(art.slug, discount?.code);
    // Compose line: index, title, artist, price and purchase link
    reply += `${idx + 1}. "${art.title}" by ${art.artist}. Price: ${priceInfo} USD. Purchase: ${url}\n`;
  });
  // Append coupon instructions and shipping/CoA details
  if (discount) {
    reply += `\nUse coupon code ${discount.code} at checkout to get ${discount.percent}% off. Fast shipping to your home in the US and a certificate of authenticity are already included.\n`;
  } else {
    reply += '\nPrices include free fast shipping to the US and a certificate of authenticity. If you would like a discount or more information, feel free to ask.\n';
  }
  return reply;
}

// Create and configure the HTTP server.  CORS headers are set for allowed
// origins.  Unsupported routes return 404.
const server = http.createServer((req, res) => {
  // CORS handling: only allow listed origins, or allow all if none specified
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  } else {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  // Health check
  if (req.method === 'GET' && parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  // Chat endpoint
  if (req.method === 'POST' && parsedUrl.pathname === '/api/chat') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const message = data.message || '';
        const results = searchArtworks(message, 3);
        const discount = decideCoupon(message);
        const reply = assembleReply(results, discount);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }
  // Realtime placeholder
  if (req.method === 'POST' && parsedUrl.pathname === '/api/realtime/session') {
    const resp = { message: 'Realtime API integration is not available in this demo.' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resp));
    return;
  }
  // Fallback 404
  res.writeHead(404);
  res.end('Not found');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`BAYA server listening on port ${port}`);
});
