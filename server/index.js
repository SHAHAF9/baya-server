    import http from 'http';
    import fs from 'fs';
    import path from 'path';
    import { URL } from 'url';

    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    const PORT = process.env.PORT || 3000;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
    const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
    const BASE_PRODUCT_URL = process.env.BASE_PRODUCT_URL || 'https://bayagallery.com/artwork/';
    const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
    const OPENAI_REALTIME_SESSIONS = 'https://api.openai.com/v1/realtime/sessions';
    const CATALOG_PATH = path.join(__dirname, '..', 'baya_catalog.json');

    function loadCatalog() {
      try { return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) || []; }
      catch(e){ return []; }
    }
    let CATALOG = loadCatalog();

    function productUrl(slug){ return `${BASE_PRODUCT_URL}${encodeURIComponent(slug||'')}`; }

    function normalizeRecord(rec, couponCode){
      const price = Number(rec.Price || rec.price || 0);
      let discount = 0;
      if (couponCode === '5OFF') discount = 5;
      if (couponCode === '10OFF') discount = 10;
      const price_final = discount ? Math.round(price * (1 - discount/100)) : price;
      return {
        art_id: rec.art_id || rec.slug || '',
        title: rec.title || '',
        artist: rec.artist || rec.Artist || '',
        price_original: price,
        price_final,
        discount_percent: discount,
        slug: rec.slug || '',
        main_image: rec.main_image || rec.image || '',
        short_spec: rec.short_spec || rec.size || '',
        product_url: productUrl(rec.slug || '')
      };
    }

    function searchArtworks(seed, n=2){
      const q = (seed||'').toLowerCase();
      const scored = CATALOG.map(r => ({
        rec: r,
        score:
          (String(r.title||'').toLowerCase().includes(q) ? 2 : 0) +
          (String(r.artist||'').toLowerCase().includes(q) ? 2 : 0) +
          (String(r.short_spec||'').toLowerCase().includes(q) ? 1 : 0)
      }));
      return scored.sort((a,b)=>b.score-a.score).slice(0, n).map(x=>x.rec);
    }

    function extractName(message){
      const m1 = (message||'').match(/\b(?:my name is|i'm|i am)\s+([A-Za-z][A-Za-z\s'-]{1,25})/i);
      if (m1) return m1[1].trim();
      const t = (message||'').trim();
      if (/^[A-Z][A-Za-z'-]{1,24}(?:\s[A-Z][A-Za-z'-]{1,24})?$/.test(t)) return t;
      return null;
    }

    function extractNeeds(blob){
      const text = (blob||'').toLowerCase();
      const room = (text.match(/(living room|bedroom|office|dining|hall|kitchen|study)/)||[])[1] || null;
      const style = (text.match(/(minimal|bold|colorful|abstract|portrait|judaica|ai)/)||[])[1] || null;
      const budget = (text.match(/\$\s?(\d[\d,\.]*)/)||[])[1] || null;
      return { room, style, budget };
    }

    function shouldOfferCoupon(text){
      const t = (text||'').toLowerCase();
      if (/expensive|pricey|too much|discount|deal|lower|best price|coupon/.test(t)) return '5OFF';
      return null;
    }

    function cors(res){
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    async function aiReply({buyerName, history, message, itemsForModel, weaveStory}){
      const sys = `You are “Maya”, BAYA Gallery’s senior design consultant.
Be human and warm, not scripted. Build rapport first; mirror the client’s words; use their NAME when known.
Ask naturally (1–2 short questions at a time), based on the last message. Avoid sounding like a form.
Offer at most 2 tailored pieces per turn; reference the items provided if they fit.
If price is a concern, suggest a 5% or 10% courtesy discount and note that they can enter 5OFF/10OFF at checkout.
Mention Oct 7 and donation to IDF only when it helps the decision — concise, respectful.
Always end with one clear CTA (reserve/proceed). Tone: premium, empathic, concise.`;

      const context = {
        buyerName,
        candidate_items: (itemsForModel||[]).map(a => ({
          title: a.title, artist: a.artist, short_spec: a.short_spec,
          price_final: a.price_final, product_url: a.product_url
        })),
        weave_story_hint: weaveStory ? 'You may briefly weave Oct 7 + donation to IDF.' : 'Only if relevant.'
      };

      const msgs = [
        { role: 'system', content: sys },
        { role: 'user', content: `CONTEXT:${JSON.stringify(context)}` }
      ];
      (history||[]).slice(-8).forEach(m => {
        msgs.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content||'' });
      });
      msgs.push({ role: 'user', content: message||'' });

      const resp = await fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type':'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.7, messages: msgs })
      }).then(r => r.json()).catch(()=>null);

      const text = resp?.choices?.[0]?.message?.content || "Tell me a little about you and the space — I’ll tailor some beautiful Israeli pieces.";
      return String(text);
    }

    const server = http.createServer(async (req, res) => {
      cors(res);
      if (req.method === 'OPTIONS'){ res.statusCode = 204; return res.end(); }

      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, {'Content-Type':'text/plain'}); return res.end('ok');
      }

      // Voice: returns ephemeral client_secret for WebRTC
      if (req.method === 'POST' && url.pathname === '/api/realtime/session') {
        try {
          if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
          const payload = { model: 'gpt-4o-realtime-preview-2024-12-17', voice: 'verse', modalities: ['text','audio'] };
          const r = await fetch(OPENAI_REALTIME_SESSIONS, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json', 'OpenAI-Beta': 'realtime=v1' },
            body: JSON.stringify(payload)
          }).then(x => x.json());
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify(r));
        } catch (e) {
          res.writeHead(500, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ error:'session_failed' }));
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/chat') {
        let body = ''; req.on('data', c => body += c);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body||'{}');
            const message = data.message || '';
            const history = Array.isArray(data.history) ? data.history : [];
            let buyerName = data.meta?.buyerName || null;
            if (!buyerName) {
              const n = extractName(message);
              if (n) buyerName = n;
            }

            const blob = [message, ...history.map(h=>h.content||'')].join(' ');
            const need = extractNeeds(blob);
            const coupon = shouldOfferCoupon(message);

            const seed = need.style || message || '';
            const recs = searchArtworks(seed, 2);
            const items = recs.map(r => normalizeRecord(r, coupon));

            const weaveStory = /love|like|interested|story|meaning|origin/i.test(message) || history.length >= 2;
            const reply = await aiReply({ buyerName, history, message, itemsForModel: items, weaveStory });

            const payload = { reply, items, meta: { buyerName } };
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify(payload));
          } catch (e) {
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ reply: "Sorry, I couldn't process that. Please try again." }));
          }
        });
        return;
      }

      res.writeHead(404, {'Content-Type':'text/plain'});
      res.end('Not Found');
    });

    server.listen(PORT, () => { console.log('baya-agent listening on', PORT); });
