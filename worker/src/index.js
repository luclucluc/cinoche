// Paris Ciné — stockage des préférences synchronisées.
//
// Un « fichier » JSON par clé de synchronisation (aucun e-mail, aucun mot de passe) :
//   GET    /prefs/<clé>  → { data, updated_at }  (404 si inconnu)
//   PUT    /prefs/<clé>  ← { data }              → { updated_at }
//   DELETE /prefs/<clé>                          → 204
// Et un relais vers la recherche Allociné (que le navigateur ne peut pas appeler directement) :
//   GET    /search?q=<texte>                     → { results: [{ id, title, originalTitle, year, directors, poster }],
//                                                    people: [{ id, name, activities }] }
// Profils partagés entre amis (facultatif, sur invitation) :
//   GET    /profile/<clé>  → { share, name, followers }  (404 si pas de profil) ; vide la boîte des nouveaux abonnés
//   PUT    /profile/<clé>  ← { name, favs, seen }        → { share }  (crée le lien de partage au besoin)
//   DELETE /profile/<clé>                                → 204  (retire le profil : le lien ne fonctionne plus)
//   GET    /u/<partage>                                  → { name, favs, seen, updated_at }  (lecture seule)
//   POST   /u/<partage>/follow ← { from: <partage> }     → 204  (suivi réciproque : prévient le propriétaire)
// La clé est un secret aléatoire de 26 caractères ; elle n'est jamais stockée telle quelle :
// l'entrée KV porte son empreinte SHA-256. Le lien de partage est un autre identifiant aléatoire,
// qui ne permet ni de retrouver la clé ni de modifier quoi que ce soit.

const ORIGINS = [/^https:\/\/luclucluc\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const KEY_RE = /^[A-Z2-9]{26}$/;
const MAX_BYTES = 100_000;
const SHARE_RE = /^[A-Z2-9]{16}$/;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newShare = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => ALPHABET[b % ALPHABET.length]).join('');

function cors(origin) {
  const ok = origin && ORIGINS.some((re) => re.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'https://luclucluc.github.io',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
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

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BYTES) return { error: 'trop volumineux', status: 413 };
  try { return { body: JSON.parse(text) }; } catch { return { error: 'JSON invalide', status: 400 }; }
}

// Profil partagé de la personne qui détient la clé
async function profile(request, env, key, h) {
  const own = 'pr:' + (await digest(key)).slice(2);
  const rec = await env.PREFS.get(own, 'json'); // { share, name }

  if (request.method === 'GET') {
    if (!rec) return json({ error: 'pas de profil' }, 404, h);
    const followers = (await env.PREFS.get('in:' + rec.share, 'json')) || [];
    if (followers.length) await env.PREFS.delete('in:' + rec.share);
    return json({ share: rec.share, name: rec.name, followers }, 200, h);
  }
  if (request.method === 'PUT') {
    const { body, error, status } = await readJson(request);
    if (error) return json({ error }, status, h);
    const name = String(body?.name || '').trim().slice(0, 40);
    if (!name) return json({ error: 'pseudo manquant' }, 400, h);
    const favs = Array.isArray(body.favs) ? body.favs : [];
    const seen = body.seen && typeof body.seen === 'object' && !Array.isArray(body.seen) ? body.seen : {};
    const share = rec?.share || newShare();
    await env.PREFS.put('u:' + share, JSON.stringify({ name, favs, seen, updated_at: new Date().toISOString() }));
    if (!rec || rec.name !== name) await env.PREFS.put(own, JSON.stringify({ share, name }));
    return json({ share }, 200, h);
  }
  if (request.method === 'DELETE') {
    if (rec) await Promise.all([env.PREFS.delete('u:' + rec.share), env.PREFS.delete('in:' + rec.share), env.PREFS.delete(own)]);
    return json(null, 204, h);
  }
  return json({ error: 'méthode non autorisée' }, 405, h);
}

// Profil public (lecture seule) et suivi réciproque
async function shared(request, env, share, action, h) {
  const pub = await env.PREFS.get('u:' + share, 'json');
  if (!pub) return json({ error: 'profil introuvable' }, 404, h);
  if (!action && request.method === 'GET') return json(pub, 200, h);
  if (action === 'follow' && request.method === 'POST') {
    const { body, error, status } = await readJson(request);
    if (error) return json({ error }, status, h);
    const from = String(body?.from || '');
    if (!SHARE_RE.test(from) || from === share || !(await env.PREFS.get('u:' + from))) return json({ error: 'profil invalide' }, 400, h);
    const inbox = (await env.PREFS.get('in:' + share, 'json')) || [];
    if (!inbox.includes(from)) inbox.push(from);
    await env.PREFS.put('in:' + share, JSON.stringify(inbox.slice(-500)));
    return json(null, 204, h);
  }
  return json({ error: 'méthode non autorisée' }, 405, h);
}

export default {
  async fetch(request, env, ctx) {
    const h = cors(request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    const url = new URL(request.url);
    if (url.pathname === '/search') {
      return request.method === 'GET' ? search(url.searchParams.get('q'), h, ctx) : json({ error: 'méthode non autorisée' }, 405, h);
    }

    const pm = url.pathname.match(/^\/profile\/([A-Za-z0-9]+)$/);
    if (pm) {
      const key = pm[1].toUpperCase();
      return KEY_RE.test(key) ? profile(request, env, key, h) : json({ error: 'clé invalide' }, 400, h);
    }
    const um = url.pathname.match(/^\/u\/([A-Za-z0-9]+)(?:\/(follow))?$/);
    if (um) {
      const share = um[1].toUpperCase();
      return SHARE_RE.test(share) ? shared(request, env, share, um[2], h) : json({ error: 'lien invalide' }, 400, h);
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
