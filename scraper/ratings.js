#!/usr/bin/env node
// Notes IMDb, Letterboxd, Rotten Tomatoes et Metacritic.
//
// Identifiants :
//   1. Wikidata (correspondance exacte depuis l'identifiant Allociné) : IMDb, Letterboxd, RT, Metacritic.
//   2. IMDb manquant → jeux de données officiels IMDb (titre + année ± 1 + durée ± 10 min, le plus voté).
//   3. Letterboxd → redirection officielle letterboxd.com/imdb/<tt>/.
//   4. RT / Metacritic manquants → adresse déduite du titre original, validée par l'année et le réalisateur.
// Notes :
//   - IMDb : title.ratings.tsv.gz (jeu de données officiel, usage non commercial).
//   - Autres : métadonnées schema.org (JSON-LD) des pages film, autorisées par les robots.txt.
// Cache : .cache/ratings.json (identifiants + notes). Les notes sont rafraîchies tous les 2 jours pour
// les films récents, tous les 10 jours pour les autres.
//
// En autonome : node scraper/ratings.js [--limit 30]  (enrichit public/data/programme.json)

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache');
const CACHE = join(CACHE_DIR, 'ratings.json');
const PROGRAMME = join(ROOT, 'public', 'data', 'programme.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const DAY = 864e5;
const RETRY_MISSING = 7 * DAY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ascii = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const norm = (s) => ascii(s).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const nameKey = (s) => ascii(s).replace(/[^a-z]/g, '');
const runtimeMin = (r) => {
  const m = String(r || '').match(/(?:(\d+)h)?\s*(?:(\d+)min)?/);
  return m && (m[1] || m[2]) ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : null;
};
const yearsOf = (m) => [m.year, m.release && Number(m.release.slice(0, 4))].filter(Boolean);

// ------------------------------------------------------------------ HTTP (un rythme par site)

const lastHit = {};
async function get(url, gap = 1000) {
  const host = new URL(url).host;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = (lastHit[host] || 0) + gap - Date.now();
    lastHit[host] = Date.now() + Math.max(0, wait);
    if (wait > 0) await sleep(wait);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.8,fr;q=0.6' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404 || res.status === 410) return null;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      return { url: res.url, html: await res.text() };
    } catch {
      await sleep(4000 * attempt);
    }
  }
  return null;
}

function movieJsonLd(html) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const raw = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(); // Letterboxd entoure le JSON de commentaires CDATA
      for (const j of [].concat(JSON.parse(raw))) {
        if (j?.['@type'] !== 'Movie') continue;
        const r = j.aggregateRating;
        return {
          year: Number(String(j.datePublished || j.dateCreated || '').slice(0, 4)) || null,
          directors: [].concat(j.director || []).map((d) => d.name),
          value: r?.ratingValue != null ? Number(r.ratingValue) : null,
          count: Number(r?.ratingCount ?? r?.reviewCount ?? 0),
        };
      }
    } catch {}
  }
  return null;
}

// Même film ? Année ± 1 obligatoire ; si les deux côtés ont un réalisateur, au moins un en commun.
function sameFilm(movie, page) {
  if (!page?.year || !yearsOf(movie).some((y) => Math.abs(y - page.year) <= 1)) return false;
  const a = new Set(movie.directors.map(nameKey));
  return !a.size || !page.directors.length || page.directors.some((d) => a.has(nameKey(d)));
}

// ------------------------------------------------------------------ Wikidata

async function wikidata(allocineIds) {
  if (!allocineIds.length) return new Map();
  const query = `SELECT ?allo ?imdb ?lb ?rt ?mc WHERE {
    VALUES ?allo { ${allocineIds.map((id) => `"${id}"`).join(' ')} }
    ?f wdt:P1265 ?allo .
    OPTIONAL { ?f wdt:P345 ?imdb } OPTIONAL { ?f wdt:P6127 ?lb } OPTIONAL { ?f wdt:P1258 ?rt } OPTIONAL { ?f wdt:P1712 ?mc }
  }`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch('https://query.wikidata.org/sparql', {
        method: 'POST',
        headers: { 'User-Agent': 'paris-cine/0.1 (+https://github.com/luclucluc/paris-cine)', Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = new Map();
      for (const b of (await res.json()).results.bindings) {
        const e = out.get(b.allo.value) || {};
        for (const k of ['imdb', 'lb', 'rt', 'mc']) if (b[k] && !e[k]) e[k] = b[k].value;
        out.set(b.allo.value, e);
      }
      return out;
    } catch (err) {
      if (attempt === 4) console.warn(`  ✗ Wikidata indisponible : ${err.message}`);
      else await sleep(10000 * attempt);
    }
  }
  return new Map();
}

// ------------------------------------------------------------------ Jeux de données IMDb

// Télécharge le fichier sur disque (avec reprise), puis le lit ligne à ligne : pas de flux réseau
// long ouvert pendant le traitement, et les erreurs sont bien remontées.
async function download(url, tries = 3) {
  const file = join(tmpdir(), 'paris-cine-' + url.split('/').pop());
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
      return file;
    } catch (err) {
      if (attempt >= tries) throw new Error(`${url} : ${err.message}`);
      await sleep(5000 * attempt);
    }
  }
}

async function* tsvLines(url) {
  const file = await download(url);
  try {
    const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) yield line;
  } finally {
    await unlink(file).catch(() => {});
  }
}

// Candidats IMDb (titre normalisé + année + durée) pour les films sans identifiant
async function imdbCandidates(films) {
  const wanted = new Map();
  for (const m of films) for (const t of new Set([norm(m.originalTitle), norm(m.title)])) if (t) (wanted.get(t) || wanted.set(t, []).get(t)).push(m);
  const cands = new Map(films.map((m) => [m, []]));
  const types = new Set(['movie', 'tvMovie', 'video', 'short', 'tvSpecial']);
  for await (const line of tsvLines('https://datasets.imdbws.com/title.basics.tsv.gz')) {
    const [tconst, type, primary, original, , start, , runtime] = line.split('\t');
    if (!types.has(type)) continue;
    const hits = new Set([...(wanted.get(norm(primary)) || []), ...(wanted.get(norm(original)) || [])]);
    for (const m of hits) {
      const y = Number(start);
      if (!yearsOf(m).some((yy) => Math.abs(yy - y) <= 1)) continue;
      const rt = runtimeMin(m.runtime), r = Number(runtime);
      if (rt && r && Math.abs(rt - r) > 10) continue;
      cands.get(m).push(tconst);
    }
  }
  return cands;
}

async function imdbRatings(tconsts) {
  const out = new Map();
  for await (const line of tsvLines('https://datasets.imdbws.com/title.ratings.tsv.gz')) {
    const tab = line.indexOf('\t');
    const id = line.slice(0, tab);
    if (!tconsts.has(id)) continue;
    const [, v, n] = line.split('\t');
    out.set(id, { v: Number(v), n: Number(n) });
  }
  return out;
}

// ------------------------------------------------------------------ Sites

const slugU = (s) => ascii(s).replace(/&/g, 'and').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const slugH = (s) => slugU(s).replace(/_/g, '-');

const SITES = {
  lb: {
    gap: 1000,
    urls: (m, ids) => (ids.lb ? [`https://letterboxd.com/film/${ids.lb}/`] : ids.imdb ? [`https://letterboxd.com/imdb/${ids.imdb}/`] : []),
    trustFirst: true, // la redirection IMDb → Letterboxd est exacte
    value: (p) => Math.round(p.value * 100) / 100, // sur 5
  },
  rt: {
    gap: 1000,
    urls: (m, ids) => {
      if (ids.rt) return [`https://www.rottentomatoes.com/${ids.rt}`];
      if (!ids.imdb) return [];
      const s = slugU(m.originalTitle || m.title);
      return s ? [`https://www.rottentomatoes.com/m/${s}`, `https://www.rottentomatoes.com/m/${s}_${m.year}`] : [];
    },
    trustFirst: (ids) => !!ids.rt,
    value: (p) => Math.round(p.value), // Tomatometer en %
  },
  mc: {
    gap: 1000,
    urls: (m, ids) => {
      if (ids.mc) return [`https://www.metacritic.com/${ids.mc.replace(/\/?$/, '/')}`];
      if (!ids.imdb) return [];
      const s = slugH(m.originalTitle || m.title);
      return s ? [`https://www.metacritic.com/movie/${s}/`, `https://www.metacritic.com/movie/${s}-${m.year}/`] : [];
    },
    trustFirst: (ids) => !!ids.mc,
    value: (p) => Math.round(p.value), // Metascore sur 100
  },
};

async function siteNote(key, m, c, now) {
  const site = SITES[key];
  const note = c.notes[key];
  const ttl = (m.release && now - new Date(m.release) < 60 * DAY ? 2 : 10) * DAY;
  if (note?.url && now - note.at < ttl) return;
  if (!note?.url && c.tried?.[key] && now - c.tried[key] < RETRY_MISSING) return;

  const trust = typeof site.trustFirst === 'function' ? site.trustFirst(c.ids) : site.trustFirst;
  const urls = note?.url ? [note.url] : site.urls(m, c.ids);
  for (const [i, url] of urls.entries()) {
    const res = await get(url, site.gap);
    if (!res) continue;
    const page = movieJsonLd(res.html);
    if (!page) continue;
    if (!note?.url && !(trust && i === 0) && !sameFilm(m, page)) continue;
    c.notes[key] = { url: res.url, v: page.value != null && page.count > 0 ? site.value(page) : null, n: page.count, at: now };
    return;
  }
  c.tried = { ...c.tried, [key]: now };
}

// ------------------------------------------------------------------ Principal

export async function addRatings(movies, { limit = Infinity } = {}) {
  await mkdir(CACHE_DIR, { recursive: true });
  const cache = JSON.parse(await readFile(CACHE, 'utf8').catch(() => '{}'));
  const now = Date.now();
  const list = Object.values(movies).slice(0, limit);
  const entry = (m) => (cache[m.allocineId] ??= { ids: {}, notes: {}, tried: {} });

  // 1. Identifiants via Wikidata (films jamais vus ou sans IMDb depuis une semaine)
  const toIdentify = list.filter((m) => !entry(m).ids.imdb && (!entry(m).idsAt || now - entry(m).idsAt > RETRY_MISSING));
  const wd = await wikidata(toIdentify.map((m) => String(m.allocineId)));
  for (const m of toIdentify) Object.assign(entry(m).ids, wd.get(String(m.allocineId)) || {});

  // 2. IMDb manquants → jeu de données title.basics
  const noImdb = toIdentify.filter((m) => !entry(m).ids.imdb);
  let cands = new Map();
  if (noImdb.length) {
    try {
      cands = await imdbCandidates(noImdb);
    } catch (err) {
      console.warn(`  ✗ IMDb (title.basics) : ${err.message}`);
    }
  }

  // 3. Notes IMDb (+ départage des candidats par nombre de votes)
  const needed = new Set([...list.map((m) => entry(m).ids.imdb), ...[...cands.values()].flat()].filter(Boolean));
  let ratings = new Map();
  try {
    ratings = await imdbRatings(needed);
  } catch (err) {
    console.warn(`  ✗ IMDb (title.ratings) : ${err.message}`);
  }
  for (const [m, ids] of cands) {
    const best = ids.sort((a, b) => (ratings.get(b)?.n || 0) - (ratings.get(a)?.n || 0))[0];
    if (best) entry(m).ids.imdb = best;
  }
  for (const m of toIdentify) entry(m).idsAt = now;

  // 4. Letterboxd, Rotten Tomatoes, Metacritic — un travailleur par site, en parallèle
  await Promise.all(
    Object.keys(SITES).map(async (key) => {
      for (const m of list) await siteNote(key, m, entry(m), now);
    })
  );

  // 5. Report dans le programme
  const stats = { imdb: 0, lb: 0, rt: 0, mc: 0 };
  for (const m of list) {
    const c = entry(m);
    const r = c.ids.imdb && ratings.get(c.ids.imdb);
    if (r) Object.assign(m, { imdb: r.v, imdbVotes: r.n, imdbId: c.ids.imdb }), stats.imdb++;
    for (const k of ['lb', 'rt', 'mc']) {
      const n = c.notes[k];
      if (n?.v != null) Object.assign(m, { [k]: n.v, [k + 'Url']: n.url }), stats[k]++;
    }
  }
  await writeFile(CACHE, JSON.stringify(cache));
  console.log(`▸ Notes sur ${list.length} films : IMDb ${stats.imdb}, Letterboxd ${stats.lb}, Rotten Tomatoes ${stats.rt}, Metacritic ${stats.mc}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--limit');
  const p = JSON.parse(await readFile(PROGRAMME, 'utf8'));
  await addRatings(p.movies, { limit: i > 0 ? Number(process.argv[i + 1]) : Infinity });
  await writeFile(PROGRAMME, JSON.stringify(p));
  console.log('✓ programme.json mis à jour');
}
