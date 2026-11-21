#!/usr/bin/env node
// Ajoute la note SensCritique (sur 10) aux films du programme.
//
// 1. Correspondance exacte Allociné → SensCritique via Wikidata (P1265 → P10100), quand elle existe.
// 2. Sinon : candidats trouvés par titre dans le sitemap public de SensCritique, puis vérification
//    sur la page du film (année ± 1 et réalisateur) pour écarter les homonymes.
// 3. La note est lue dans les métadonnées schema.org (JSON-LD) de la page du film.
//
// Seules les pages /film/… (autorisées par robots.txt) et les sitemaps sont consultés, à un rythme lent.
// Un cache (.cache/senscritique.json) évite de tout refaire chaque nuit.
//
// En autonome : node scraper/senscritique.js [--limit 30]  (enrichit public/data/programme.json)

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache');
const CACHE = join(CACHE_DIR, 'senscritique.json');
const SITEMAP_CACHE = join(CACHE_DIR, 'senscritique-films.txt');
const PROGRAMME = join(ROOT, 'public', 'data', 'programme.json');

const SC = 'https://www.senscritique.com';
const UA = 'Mozilla/5.0 (compatible; paris-cine/0.1; +https://github.com/luclucluc/paris-cine)';
const GAP = 700; // ms entre deux requêtes SensCritique
const DAY = 864e5;
const MAX_CANDIDATES = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function scGet(url, { binary = false } = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait = last + GAP - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch {
      await sleep(3000 * attempt);
    }
  }
  return null;
}

// ------------------------------------------------------------------ Normalisation

const ascii = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const nameKey = (s) => ascii(s).replace(/[^a-z]/g, '');

function slugs(title) {
  if (!title) return [];
  const s = ascii(title);
  return [...new Set([s.replace(/[^a-z0-9]+/g, '_'), s.replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '_')].map((x) => x.replace(/^_+|_+$/g, '')))].filter(Boolean);
}

// ------------------------------------------------------------------ Sources

async function loadSitemapIndex() {
  const fresh = await stat(SITEMAP_CACHE).then((s) => Date.now() - s.mtimeMs < 7 * DAY, () => false);
  let lines;
  if (fresh) {
    lines = (await readFile(SITEMAP_CACHE, 'utf8')).split('\n');
  } else {
    const index = await scGet(`${SC}/sitemaps/products.xml`);
    const files = [...(index || '').matchAll(/<loc>([^<]*\/film\/film_\d+\.xml\.gz)<\/loc>/g)].map((m) => m[1]);
    lines = [];
    for (const f of files) {
      const gz = await scGet(f, { binary: true });
      if (!gz) continue;
      for (const m of gunzipSync(gz).toString('utf8').matchAll(/<loc>https:\/\/www\.senscritique\.com\/film\/([^/<]+)\/(\d+)<\/loc>/g)) lines.push(`${m[1]} ${m[2]}`);
    }
    if (lines.length > 100000) await writeFile(SITEMAP_CACHE, lines.join('\n'));
    else console.warn(`  ✗ sitemap SensCritique incomplet (${lines.length} films)`);
  }
  const idx = new Map();
  for (const line of lines) {
    const [slug, id] = line.split(' ');
    if (!id) continue;
    (idx.get(slug) || idx.set(slug, []).get(slug)).push(id);
  }
  return idx;
}

async function wikidataMap(allocineIds) {
  if (!allocineIds.length) return new Map();
  const query = `SELECT ?allo ?sc WHERE { VALUES ?allo { ${allocineIds.map((id) => `"${id}"`).join(' ')} } ?f wdt:P1265 ?allo ; wdt:P10100 ?sc . }`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch('https://query.wikidata.org/sparql', {
        method: 'POST',
        headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return new Map(data.results.bindings.map((b) => [b.allo.value, b.sc.value]));
    } catch (err) {
      if (attempt === 4) console.warn(`  ✗ Wikidata indisponible : ${err.message}`);
      else await sleep(10000 * attempt);
    }
  }
  return new Map();
}

async function filmPage(scId) {
  const html = await scGet(`${SC}/film/_/${scId}`);
  if (!html) return null;
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      if (j['@type'] !== 'Movie') continue;
      return {
        id: String(scId),
        url: j.url || `${SC}/film/_/${scId}`,
        year: Number(String(j.datePublished || '').slice(0, 4)) || null,
        directors: [].concat(j.director || []).map((d) => d.name),
        rating: j.aggregateRating?.ratingValue ?? null,
        votes: j.aggregateRating?.ratingCount ?? 0,
      };
    } catch {}
  }
  return null;
}

// Score d'un candidat : l'année doit concorder ; le réalisateur départage (et peut éliminer).
function score(movie, page) {
  if (!page) return -1;
  const years = [movie.year, movie.release && Number(movie.release.slice(0, 4))].filter(Boolean);
  const yearOk = page.year && years.some((y) => Math.abs(y - page.year) <= 1);
  if (!yearOk) return -1;
  const a = new Set(movie.directors.map(nameKey));
  const b = page.directors.map(nameKey);
  if (a.size && b.length) return b.some((d) => a.has(d)) ? 3 : -1;
  return 1;
}

// ------------------------------------------------------------------ Principal

export async function addSensCritique(movies, { limit = Infinity } = {}) {
  await mkdir(CACHE_DIR, { recursive: true });
  const cache = JSON.parse(await readFile(CACHE, 'utf8').catch(() => '{}'));
  const now = Date.now();
  const list = Object.values(movies).slice(0, limit);

  const isRecent = (m) => m.release && now - new Date(m.release) < 60 * DAY;
  const needsMatch = list.filter((m) => {
    const c = cache[m.allocineId];
    return !c || (!c.sc && now - c.tried > 7 * DAY);
  });

  const wd = await wikidataMap(needsMatch.map((m) => String(m.allocineId)));
  const idx = needsMatch.some((m) => !wd.has(String(m.allocineId))) ? await loadSitemapIndex() : new Map();

  let matched = 0, refreshed = 0, unmatched = 0;
  for (const m of list) {
    const key = m.allocineId;
    let c = cache[key];

    if (needsMatch.includes(m)) {
      let best = null;
      if (wd.has(String(key))) {
        best = await filmPage(wd.get(String(key)));
      } else {
        const keys = [...slugs(m.title), ...slugs(m.originalTitle)];
        const ids = [...new Set(keys.flatMap((k) => [...(m.year ? idx.get(`${k}_${m.year}`) || [] : []), ...(idx.get(k) || [])]))].slice(0, MAX_CANDIDATES);
        let bestScore = 0;
        for (const id of ids) {
          const page = await filmPage(id);
          const s = score(m, page);
          if (s > bestScore) [best, bestScore] = [page, s];
          if (s === 3) break;
        }
      }
      c = cache[key] = best
        ? { sc: best.id, url: best.url, rating: best.rating, votes: best.votes, at: now, tried: now }
        : { sc: null, tried: now };
      best ? matched++ : unmatched++;
    } else if (c.sc && now - c.at > (isRecent(m) ? 2 : 10) * DAY) {
      const page = await filmPage(c.sc);
      if (page) Object.assign(c, { rating: page.rating, votes: page.votes, url: page.url, at: now });
      refreshed++;
    }

    if (c?.sc && c.rating != null && c.votes > 0) {
      m.sc = Math.round(c.rating * 10) / 10;
      m.scVotes = c.votes;
      m.scUrl = c.url;
    }
  }

  await writeFile(CACHE, JSON.stringify(cache));
  const withNote = list.filter((m) => m.sc != null).length;
  console.log(`▸ SensCritique : ${withNote}/${list.length} films notés (${matched} nouvelles correspondances, ${refreshed} notes rafraîchies, ${unmatched} introuvables)`);
}

// Exécution autonome
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--limit');
  const limit = i > 0 ? Number(process.argv[i + 1]) : Infinity;
  const p = JSON.parse(await readFile(PROGRAMME, 'utf8'));
  await addSensCritique(p.movies, { limit });
  await writeFile(PROGRAMME, JSON.stringify(p));
  console.log('✓ programme.json mis à jour');
}
