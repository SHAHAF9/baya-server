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
 * Assemble a persuasive response summarising artwork suggestions along with
 * pricing information, optional discount and a clear call to action.  This
 * function is used by the chat endpoint to format the JSON reply for the
 * client during the recommendation phase.  Each item includes a Buy Now
 * link generated from buildCheckoutUrl().
 *
 * @param {Array<Object>} results   List of artwork records.
 * @param {Object|null} discount    Discount information returned by decideCoupon.
 * @returns {string}                 Human‑readable response in English.
 */
function assembleSellingReply(results, discount) {
  // If no results, apologise gracefully
  if (!results.length) {
    return "I'm sorry, I couldn't find suitable artworks at this time.";
  }
  let reply = 'Here are some curated recommendations for you:\n';
  results.forEach((art, idx) => {
    const price = Number(art.price || 0);
    let finalPrice = price;
    if (discount) {
      finalPrice = Math.round(price * (100 - discount.percent)) / 100;
    }
    const url = buildCheckoutUrl(art.slug, discount?.code);
    const priceInfo = discount ? `$${finalPrice} (instead of $${price})` : `$${price}`;
    // short_spec may be empty; show only if available
    const spec = art.short_spec ? `${art.short_spec}.` : '';
    reply += `${idx + 1}. "${art.title}" by ${art.artist}. ${spec} Price: ${priceInfo}. Buy: ${url}\n`;
  });
  // Mention free shipping and certificate of authenticity
  reply += '\nPrices include free fast shipping to the US and a certificate of authenticity.';
  if (discount) {
    reply += ` As a courtesy, I've applied a ${discount.percent}% discount above.`;
  }
  reply += '\nWould you like me to reserve one of these pieces for you today?';
  return reply;
}

/**
 * Extract conversation state from the provided history.  This helper scans
 * prior user and assistant messages to determine whether the assistant has
 * already asked for or received information about the room, style and
 * budget, whether recommendations have been presented, whether the
 * October 7 story and donation to IDF have been mentioned, and whether
 * a discount has been offered.  It does not attempt to capture exact
 * values; only presence/absence is tracked.
 *
 * @param {Array<Object>} history   The conversation history as an array of
 *                                  messages with roles 'user' and 'assistant'.
 * @returns {Object}                The extracted state.
 */
function extractState(history) {
  let room = false;
  let style = false;
  let budget = false;
  let recommended = false;
  let storyTold = false;
  let discountOffered = false;
  // track if discount offered via code in assistant message (percent off)
  history.forEach(msg => {
    const text = String(msg.content || '').toLowerCase();
    if (msg.role === 'assistant') {
      if (/here are some curated|refined pick|recommended artworks|curated recommendations/i.test(text)) {
        recommended = true;
      }
      if (/october 7|7 october|idf|soldiers|donation/i.test(text)) {
        storyTold = true;
      }
      if (/\d+%/i.test(text) && /discount|off/.test(text)) {
        discountOffered = true;
      }
    } else if (msg.role === 'user') {
      // detect room names
      if (!room && /(living room|bedroom|office|kitchen|dining|study|foyer)/i.test(text)) {
        room = true;
      }
      // detect style keywords
      if (!style && /(abstract|minimal|minimalist|modern|contemporary|bold|colorful|monochrom|industrial|classic)/i.test(text)) {
        style = true;
      }
      // detect budget or price numbers; any mention of budget/cost counts
      if (!budget && (/\$\s*\d+/.test(text) || /\d+\s*usd/.test(text) || /(budget|price|cost|how much)/i.test(text))) {
        budget = true;
      }
    }
  });
  return { room, style, budget, recommended, storyTold, discountOffered };
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
        // History may be provided by the client to maintain context.  It should
        // be an array of { role, content } objects representing prior turns.
        const history = Array.isArray(data.history) ? data.history.slice() : [];
        // Append the current user message to the conversation for state analysis.
        const combined = history.concat([{ role: 'user', content: message }]);
        const state = extractState(combined);

        let reply;

        // Determine the next step based on what information has been gathered.
        if (!state.room) {
          reply = "To help me curate the perfect piece, could you tell me which room you’re styling? For example: living room, bedroom, office, kitchen, or study.";
        } else if (!state.style) {
          reply = "What style of art speaks to you? Some clients prefer abstract, minimalist, bold or classic pieces."
            + " Let me know your taste so I can tailor my suggestions.";
        } else if (!state.budget) {
          reply = "Do you have a comfortable budget range in mind? That will help me refine recommendations to fit within it.";
        } else if (!state.recommended) {
          // Offer recommendations once room, style and budget have been discussed.
          // Provide up to three pieces that match the current query.  If a discount
          // has not yet been offered and the message indicates price sensitivity,
          // decideCoupon will return a code.  Otherwise discount is null.
          const discount = state.discountOffered ? null : decideCoupon(message);
          const results = searchArtworks(message, 3);
          reply = assembleSellingReply(results, discount);
        } else if (!state.storyTold) {
          // After recommending artworks, share the gallery’s story and purpose.
          reply = "By the way, after the tragic events of October 7, our gallery had to pause operations for nearly two years. "
            + "Today, every artwork purchased not only supports Israeli artists but also contributes to a donation we make to IDF soldiers. "
            + "It’s art with both beauty and purpose. Let me know which piece resonates most with you.";
        } else {
          // In later turns, check if the user’s latest message shows price hesitation
          // and offer a discount if one hasn’t been applied yet.  Otherwise keep
          // the conversation open and invite them to decide.
          let discount = null;
          if (!state.discountOffered) {
            discount = decideCoupon(message);
          }
          if (discount) {
            const results = searchArtworks(message, 3);
            reply = assembleSellingReply(results, discount);
          } else {
            reply = "Is there anything else I can help you with regarding these pieces? I’d be delighted to reserve one of them for you.";
          }
        }

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