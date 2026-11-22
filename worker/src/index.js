// Paris Ciné — stockage des préférences synchronisées.
//
// Un « fichier » JSON par clé de synchronisation (aucun e-mail, aucun mot de passe) :
//   GET    /prefs/<clé>  → { data, updated_at }  (404 si inconnu)
//   PUT    /prefs/<clé>  ← { data }              → { updated_at }
//   DELETE /prefs/<clé>                          → 204
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

export default {
  async fetch(request, env) {
    const h = cors(request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    const m = new URL(request.url).pathname.match(/^\/prefs\/([A-Za-z0-9]+)$/);
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
