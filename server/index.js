  import http from 'http'
  import fs from 'fs'
  import path from 'path'
  import fetch from 'node-fetch'
  import { URL } from 'url'
  import dotenv from 'dotenv'

  dotenv.config()

  const __dirname = path.dirname(new URL(import.meta.url).pathname)
  const PORT = process.env.PORT || 3000
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'
  const BASE_PRODUCT_URL = process.env.BASE_PRODUCT_URL || 'https://bayagallery.com/artwork/'
  const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'
  const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models'
  const OPENAI_REALTIME_SESSIONS = 'https://api.openai.com/v1/realtime/sessions'
  const CATALOG_PATH = path.join(__dirname, '..', 'baya_catalog.json')

  function loadCatalog(){
    try { return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) || [] } catch(e) { return [] }
  }
  let CATALOG = loadCatalog()

  function productUrl(slug){ return BASE_PRODUCT_URL + encodeURIComponent(slug || '') }

  function normalizeRecord(rec, couponCode){
    const price = Number(rec.Price || rec.price || 0)
    let discount = 0
    if (couponCode === '5OFF') discount = 5
    if (couponCode === '10OFF') discount = 10
    const price_final = discount ? Math.round(price * (1 - discount/100)) : price
    return {
      art_id: rec.art_id || rec.slug || '',
      title: rec.title || '',
      artist: rec.artist || rec.Artist || '',
      price_original: price,
      price_final: price_final,
      discount_percent: discount,
      slug: rec.slug || '',
      main_image: rec.main_image || rec.image || '',
      short_spec: rec.short_spec || rec.size || '',
      product_url: productUrl(rec.slug || '')
    }
  }

  const SESS = new Map()
  function getSession(meta){
    const sid = meta && meta.sessionId ? meta.sessionId : 'default'
    if (!SESS.has(sid)) SESS.set(sid, { name: null, location: null, room: null, style: null, budget: null, _history: [] })
    return { sid: sid, state: SESS.get(sid) }
  }

  function searchArtworks(seed, n){
    const q = String(seed || '').toLowerCase()
    const scored = CATALOG.map(function(r){
      const score =
        (String(r.title || '').toLowerCase().includes(q) ? 2 : 0) +
        (String(r.artist || '').toLowerCase().includes(q) ? 2 : 0) +
        (String(r.short_spec || '').toLowerCase().includes(q) ? 1 : 0)
      return { rec: r, score: score }
    })
    return scored.sort(function(a,b){ return b.score - a.score }).slice(0, n).map(function(x){ return x.rec })
  }

  function extractName(message){
    const m1 = String(message || '').match(/\b(?:my name is|i'm|i am)\s+([A-Za-z][A-Za-z\s'-]{1,25})/i)
    if (m1) return m1[1].trim()
    const t = String(message || '').trim()
    if (/^[A-Z][A-Za-z'-]{1,24}(?:\s[A-Z][A-Za-z'-]{1,24})?$/.test(t)) return t
    return null
  }
  function extractLocation(message){
    const m = String(message || '').match(/\bfrom\s+([A-Za-z][A-Za-z\s'-]{2,40})/i)
    return m ? m[1].trim() : null
  }
  function extractNeeds(blob){
    const text = String(blob || '').toLowerCase()
    const roomMatch = text.match(/(living room|bedroom|office|dining|hall|kitchen|study)/)
    const styleMatch = text.match(/(minimal|bold|colorful|abstract|portrait|judaica|ai)/)
    const budgetMatch = text.match(/\$\s?(\d[\d,\.]*)/)
    return {
      room: roomMatch ? roomMatch[1] : null,
      style: styleMatch ? styleMatch[1] : null,
      budget: budgetMatch ? budgetMatch[1] : null
    }
  }

  function cors(res){
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  }

  function summarizeFilled(state){
    const filled = []
    if (state.room) filled.push('room')
    if (state.style) filled.push('style')
    if (state.budget) filled.push('budget')
    if (state.location) filled.push('location')
    return filled
  }

  async function composeHumanReply(params){
    const state = params.state
    const buyerName = params.buyerName
    const message = params.message
    const items = params.items

    const filled = summarizeFilled(state)
    const askable = ['room','style','budget'].filter(function(x){ return filled.indexOf(x) === -1 })
    const sys =
`You are Maya, BAYA Gallery’s senior design consultant. Speak like a person. Warm. Confident. Brief. One question at a time. Use the client’s name. Mirror key words they use. Build rapport first. Then guide to a decision. Offer 1 to 2 artworks only when relevant. Link to the artwork page. Mention that prices include free fast shipping to the US and a certificate of authenticity. If price resistance appears, offer 5OFF first. Offer 10OFF only if they hesitate again. Ask to reserve the piece. Be respectful. If it helps the decision, mention that after October 7 the gallery paused, and each purchase supports Israeli artists and includes a donation to IDF soldiers. Keep it short. Always end with one clear next step.

Rules
Never repeat the same line. Avoid generic openers. Use one short follow up only. If a slot is filled, do not ask it again. Use the buyer name one time per turn.

State
BUYER_NAME=${buyerName || ''}
LOCATION=${state.location || ''}
FILLED=${filled.join(', ') || 'none'}
MISSING=${askable.join(', ') || 'none'}

Candidate items
${JSON.stringify(items.map(function(i){ return { title: i.title, artist: i.artist, short_spec: i.short_spec, price_final: i.price_final, product_url: i.product_url } }))}
`

    const hist = (state._history || []).slice(-8)
    const msgs = [{ role: 'system', content: sys }].concat(hist).concat([{ role: 'user', content: message || '' }])

    const resp = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.7, messages: msgs })
    }).then(function(r){ return r.json() }).catch(function(){ return null })

    const txt = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content
      ? resp.choices[0].message.content
      : "Tell me one thing about your space or taste, I will tailor it for you."
    return String(txt)
  }

  const server = http.createServer(async function(req, res){
    cors(res)
    if (req.method === 'OPTIONS'){ res.statusCode = 204; return res.end() }
    const url = new URL(req.url, 'http://' + req.headers.host)

    if (req.method === 'GET' && url.pathname === '/health'){
      const ok = OPENAI_API_KEY ? 'ok' : 'missing_openai_key'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: ok }))
    }

    if (req.method === 'GET' && url.pathname === '/health/openai'){
      try{
        if (!OPENAI_API_KEY) throw new Error('missing_key')
        const r = await fetch(OPENAI_MODELS_URL, {
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY }
        })
        const status = r.status
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ reachable: status === 200, status }))
      }catch(e){
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ reachable: false }))
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/realtime/session'){
      try{
        if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY')
        const payload = { model: 'gpt-4o-realtime-preview-2024-12-17', voice: 'verse', modalities: ['text','audio'] }
        const r = await fetch(OPENAI_REALTIME_SESSIONS, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json', 'OpenAI-Beta': 'realtime=v1' },
          body: JSON.stringify(payload)
        }).then(function(x){ return x.json() })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(r))
      }catch(e){
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'session_failed' }))
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/chat'){
      let body = ''
      req.on('data', function(c){ body += c })
      req.on('end', async function(){
        try{
          const data = JSON.parse(body || '{}')
          const message = data.message || ''
          const history = Array.isArray(data.history) ? data.history : []
          const meta = data.meta || {}
          const session = getSession(meta)
          const state = session.state

          state._history = (state._history || []).concat(history.map(function(h){ return { role: h.role === 'user' ? 'user' : 'assistant', content: h.content || '' } }))

          let name = meta.buyerName || state.name || extractName(message)
          let location = state.location || extractLocation(message)
          const blob = [message].concat(history.map(function(h){ return h.content || '' })).join(' ')
          const need = extractNeeds(blob)
          if (name) state.name = name
          if (location) state.location = location
          if (need.room) state.room = need.room
          if (need.style) state.style = need.style
          if (need.budget) state.budget = need.budget

          const seed = state.style || message || ''
          const recs = searchArtworks(seed, 2)
          const items = recs.map(function(r){ return normalizeRecord(r, null) })

          const reply = await composeHumanReply({ state: state, buyerName: state.name, message: message, items: items })

          const payload = { reply: reply, items: items, meta: { buyerName: state.name, sessionId: session.sid } }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(payload))
        }catch(e){
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ reply: "Sorry, I could not process that. Please try again." }))
        }
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  server.listen(PORT, function(){ console.log('baya-agent listening on', PORT) })
