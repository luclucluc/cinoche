// Paris Ciné — stockage des préférences synchronisées.
//
// Un « fichier » JSON par clé de synchronisation (aucun e-mail, aucun mot de passe) :
//   GET    /prefs/<clé>  → { data, updated_at }  (404 si inconnu)
//   PUT    /prefs/<clé>  ← { data }              → { updated_at }
//   DELETE /prefs/<clé>                          → 204
// Et un relais vers la recherche Allociné (que le navigateur ne peut pas appeler directement) :
//   GET    /search?q=<texte>                     → { results: [{ id, title, originalTitle, year, directors, poster }],
//                                                    people: [{ id, name, activities }] }
// La clé est un secret aléatoire de 26 caractères ; elle n'est jamais stockée telle quelle :
// l'entrée KV porte son empreinte SHA-256.

const ORIGINS = [/^https:\/\/luclucluc\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const KEY_RE = /^[A-Z2-9]{26}$/;
const MAX_BYTES = 100_000;

function cors(origin) {
  const ok = origin && ORIGINS.some((re) => re.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'https://luclucluc.github.io',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, headers) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function digest(key) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return 'p:' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Films et personnes, réduits aux champs utiles ; réponses gardées un jour en cache
async function search(raw, h, ctx) {
  const q = (raw || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
  if (q.length < 2) return json({ results: [] }, 200, h);
  const ok = (body) => new Response(body, { status: 200, headers: { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
  const cacheKey = new Request('https://paris-cine-sync.cache/search?q=' + encodeURIComponent(q));
  const hit = await caches.default.match(cacheKey);
  if (hit) return ok(await hit.text());
  let d;
  try {
    const r = await fetch('https://www.allocine.fr/_/autocomplete/' + encodeURIComponent(q), {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' },
    });
    if (!r.ok) throw new Error(String(r.status));
    d = await r.json();
  } catch {
    return json({ error: 'recherche indisponible' }, 502, h);
  }
  const results = (d.results || [])
    .filter((x) => x.entity_type === 'movie')
    .map((x) => ({
      id: String(x.entity_id),
      title: x.label,
      originalTitle: x.original_label && x.original_label !== x.label ? x.original_label : null,
      year: x.data?.year && x.data.year !== 'null' ? x.data.year : null,
      directors: x.data?.director_name || [],
      poster: x.data?.poster_path || null,
    }));
  const people = (d.results || [])
    .filter((x) => x.entity_type === 'person')
    .map((x) => ({ id: String(x.entity_id), name: x.label, activities: x.data?.activities || [] }));
  const body = JSON.stringify({ results, people });
  ctx.waitUntil(caches.default.put(cacheKey, new Response(body, { headers: { 'Cache-Control': 'public, max-age=86400' } })));
  return ok(body);
}

export default {
  async fetch(request, env, ctx) {
    const h = cors(request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    const url = new URL(request.url);
    if (url.pathname === '/search') {
      return request.method === 'GET' ? search(url.searchParams.get('q'), h, ctx) : json({ error: 'méthode non autorisée' }, 405, h);
    }

    const m = url.pathname.match(/^\/prefs\/([A-Za-z0-9]+)$/);
    if (!m) return json({ error: 'introuvable' }, 404, h);
    const key = m[1].toUpperCase();
    if (!KEY_RE.test(key)) return json({ error: 'clé invalide' }, 400, h);
    const id = await digest(key);

    if (request.method === 'GET') {
      const stored = await env.PREFS.get(id, 'json');
      return stored ? json(stored, 200, h) : json({ error: 'inconnu' }, 404, h);
    }

    if (request.method === 'PUT') {
      const text = await request.text();
      if (text.length > MAX_BYTES) return json({ error: 'trop volumineux' }, 413, h);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: 'JSON invalide' }, 400, h); }
      if (!body || typeof body.data !== 'object' || Array.isArray(body.data)) return json({ error: 'format invalide' }, 400, h);
      const updated_at = new Date().toISOString();
      await env.PREFS.put(id, JSON.stringify({ data: body.data, updated_at }));
      return json({ updated_at }, 200, h);
    }

    if (request.method === 'DELETE') {
      await env.PREFS.delete(id);
      return json(null, 204, h);
    }

    return json({ error: 'méthode non autorisée' }, 405, h);
  },
};
