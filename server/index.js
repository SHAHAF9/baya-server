import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const BASE_PRODUCT_URL = process.env.BASE_PRODUCT_URL || 'https://bayagallery.com/artwork/';
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

function searchArtworks(q, n=2){
  const query = (q||'').toLowerCase().trim();
  const scored = CATALOG.map(r => ({
    rec: r,
    score:
      (String(r.title||'').toLowerCase().includes(query) ? 2 : 0) +
      (String(r.artist||'').toLowerCase().includes(query) ? 2 : 0) +
      (String(r.short_spec||'').toLowerCase().includes(query) ? 1 : 0)
  }));
  return scored.sort((a,b)=>b.score-a.score).slice(0,n).map(x=>x.rec);
}

function extractState(message, history){
  const blob = [message, ...(history||[]).map(h=>h.content||'')].join(' ').toLowerCase();
  const nameMatch = (message||'').match(/\b(?:my name is|i'm|i am)\s+([A-Za-z][A-Za-z\s'-]{1,25})/i);
  const name = nameMatch ? nameMatch[1].trim() : null;
  const roomMatch = blob.match(/(living room|bedroom|office|dining|hall|kitchen|study)/);
  const styleMatch = blob.match(/(minimal|bold|colorful|abstract|portrait|judaica|ai)/);
  const budgetMatch = blob.match(/\$\s?(\d[\d,\.]*)/);
  return {
    name,
    need:{
      room: roomMatch ? roomMatch[1] : null,
      style: styleMatch ? styleMatch[1] : null,
      budget: budgetMatch ? budgetMatch[1] : null
    }
  };
}

function shouldOfferCoupon(text){
  const t = (text||'').toLowerCase();
  if (/expensive|too much|pricey|discount|lower|deal|offer/.test(t)) return '5OFF';
  return null;
}

function maybeWeaveStory(history, message){
  const all = [ ...(history||[]).map(h=>h.content||''), message||'' ].join(' ').toLowerCase();
  const already = /october\s*7|donation\s*to\s*idf|support\s*idf/.test(all);
  const interest = /(love|like|interested|meaning|story|origin|artist)/.test((message||'').toLowerCase());
  return !already && interest;
}

function assembleReply({name, need, items, coupon, weaveStory}){
  const parts = [];
  if (!name) {
    parts.push("Hi! I’m Maya, BAYA Gallery’s senior design consultant. What’s your name?");
    return parts.join(' ');
  }
  if (!need.room || !need.style || !need.budget) {
    const ask = [];
    if (!need.room) ask.push('which room you’re styling');
    if (!need.style) ask.push('what vibe you love (minimal, bold, colorful, abstract)');
    if (!need.budget) ask.push('a comfortable budget');
    parts.push(`Lovely to meet you, ${name}. To curate properly, could you tell me ${ask.join(', ')}?`);
    return parts.join(' ');
  }

  if (items && items.length){
    parts.push(`Based on what you shared, here ${items.length>1?'are a couple of refined picks':'is a strong pick'} for your ${need.room}:`);
  }

  if (weaveStory){
    parts.push(`By the way, after the October 7 tragedy, our gallery had to pause for almost two years. Now, every artwork purchased supports Israeli artists and includes a donation to IDF soldiers — beauty with real purpose.`);
  }

  if (coupon){
    parts.push(`If price is a consideration, I can extend a **${coupon.replace('OFF','%')} courtesy** today; you can apply the code **${coupon}** at checkout.`);
  }

  parts.push(`Would you like me to reserve your favorite so it’s on its way today?`);
  return parts.join('\n\n');
}

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const server = http.createServer((req,res)=>{
  cors(res);
  if (req.method === 'OPTIONS'){ res.statusCode = 204; return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/health'){
    res.writeHead(200, {'Content-Type':'text/plain'}); return res.end('ok');
  }

  if (req.method === 'POST' && url.pathname === '/api/chat'){
    let body=''; req.on('data', c=> body+=c);
    req.on('end', ()=>{
      try{
        const data = JSON.parse(body||'{}');
        const message = data.message || '';
        const history = Array.isArray(data.history) ? data.history : [];
        let name = data.meta?.buyerName || null;
        const extracted = extractState(message, history);
        if (!name && extracted.name) name = extracted.name;

        const need = extracted.need;
        const coupon = shouldOfferCoupon(message);
        const seed = (need.style || message || '').trim();
        const recs = searchArtworks(seed, 2);
        const items = recs.map(r => normalizeRecord(r, coupon));

        const weaveStory = maybeWeaveStory(history, message);
        const reply = assembleReply({name, need, items, coupon, weaveStory});
        const payload = { reply, items, meta: { buyerName: name } };

        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(payload));
      }catch(e){
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ reply: "Sorry, I couldn't process that. Please try again." }));
      }
    });
    return;
  }

  res.writeHead(404, {'Content-Type':'text/plain'});
  res.end('Not Found');
});

server.listen(PORT, ()=>{
  console.log('baya-agent listening on', PORT);
});
