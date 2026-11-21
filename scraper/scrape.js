#!/usr/bin/env node
// Récupère le programme des cinémas de Paris (+ proche banlieue) depuis Allociné
// et écrit public/data/programme.json, consommé par l'interface.
//
// Usage : node scraper/scrape.js [--days 7] [--paris-only]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARIS_CITY_ID, DEPARTMENTS, EXTRA_CITIES, DEFAULT_DAYS, CONCURRENCY, THEATERS_TTL_DAYS } from './config.js';
import { geocodeTheaters } from './geocode.js';
import { addSensCritique } from './senscritique.js';
import { addRatings } from './ratings.js';
import { cinechequeTheaters } from './cinecheque.js';
import { addFullCast } from './cast.js';

const BASE = 'https://www.allocine.fr';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data', 'programme.json');
const ZONES_CACHE = join(ROOT, '.cache', 'allocine-zones.json');

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DAYS = Number(argVal('--days', DEFAULT_DAYS));
const PARIS_ONLY = args.includes('--paris-only');

// ---------------------------------------------------------------- HTTP

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Limiteur global : au plus une requête toutes les MIN_GAP ms, pour rester courtois.
const MIN_GAP = 400;
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP;
  if (wait) await sleep(wait);
}

async function get(path, { json = true, tries = 6 } = {}) {
  for (let attempt = 1; ; attempt++) {
    await throttle();
    try {
      const res = await fetch(BASE + path, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return false; // absent (≠ échec réseau, qui renvoie null)
      if (res.status === 429) {
        // Pause globale (plafonnée à 60 s) : tous les workers attendent.
        const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 10 * attempt, 60);
        console.warn(`\n  … limite de débit atteinte, pause ${retryAfter} s`);
        nextSlot = Math.max(nextSlot, Date.now() + retryAfter * 1000);
        throw new Error('HTTP 429');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (err) {
      if (attempt >= tries) {
        console.warn(`\n  ✗ ${path} : ${err.message}`);
        return null;
      }
      await sleep(500 * 2 ** attempt);
    }
  }
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

// ---------------------------------------------------------------- Villes & salles

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

// Communes officielles d'un département (geo.api.gouv.fr)
async function communesOf(dep) {
  const res = await fetch(`https://geo.api.gouv.fr/departements/${dep}/communes?fields=nom,codesPostaux`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`geo.api.gouv.fr ${dep} : HTTP ${res.status}`);
  return (await res.json()).map((c) => ({ name: c.nom, zips: c.codesPostaux }));
}

// Commune → ville Allociné : nom identique, ou à défaut même code postal et nom proche
async function resolveCity({ name, zips }) {
  const data = await get(`/_/localization_city/${encodeURIComponent(name)}`);
  if (!data?.values) return undefined; // échec réseau : ne pas mettre en cache
  const cities = (data.values.cities || []).map((c) => c.node).filter((c) => zips.includes(String(c.zip)));
  const n = norm(name);
  const city = cities.find((c) => norm(c.name) === n) || cities.find((c) => norm(c.name).startsWith(n) || n.startsWith(norm(c.name)));
  return city ? { id: city.id, name: city.name } : null;
}

const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

async function theatersOfCity(city) {
  const found = [];
  for (let page = 1; page < 30; page++) {
    const html = await get(`/salle/cinema/ville-${city.id}/${page > 1 ? `?page=${page}` : ''}`, { json: false });
    if (html === false) break; // pas (ou plus) de page : liste terminée
    if (!html) {
      if (page === 1) return null; // échec réseau : on gardera la liste en cache
      break;
    }
    const cards = html.split('class="theater-card').slice(1);
    const before = found.length;
    for (const card of cards) {
      const meta = card.match(/data-theater="([^"]+)"/);
      if (!meta) continue;
      const { id, name } = JSON.parse(decode(meta[1]));
      const address = decode(card.match(/<address[^>]*>([^<]*)<\/address>/)?.[1] || '');
      const screens = Number(card.match(/screen-number">\s*(\d+)/)?.[1]) || null;
      if (!found.some((t) => t.id === id)) found.push({ id, name: decode(name), address, screens, area: areaOf(address, city.name), dept: address.match(/\b(75|9[1-5])\d{3}\b/)?.[1] || null });
    }
    if (found.length === before) break; // page vide ou répétée → fin
  }
  return found;
}

function areaOf(address, cityName) {
  const zip = address.match(/\b(75\d{3}|9[1-5]\d{3})\b/)?.[1];
  if (zip?.startsWith('75')) {
    const arr = Number(zip.slice(3)) || 16; // 75116 → 16e
    return arr === 1 ? 'Paris 1er' : `Paris ${arr}e`;
  }
  return cityName;
}

// ---------------------------------------------------------------- Séances

function isoDay(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); // YYYY-MM-DD
}

const personName = (p) => [p?.firstName, p?.lastName].filter(Boolean).join(' ');

function movieRecord(m) {
  const release = m.releases?.find((r) => r.releaseTags?.tagTypes?.includes('THEATER'))?.releaseDate?.date || m.releases?.[0]?.releaseDate?.date || null;
  return {
    title: m.title,
    originalTitle: m.originalTitle && m.originalTitle !== m.title ? m.originalTitle : null,
    poster: m.poster?.path || null,
    runtime: m.runtime || null,
    year: m.data?.productionYear || (release ? Number(release.slice(0, 4)) : null),
    release,
    genres: (m.genres || []).map((g) => g.translate),
    directors: (m.credits || []).filter((c) => c.position?.name === 'DIRECTOR').map((c) => personName(c.person)),
    cast: (m.cast?.edges || []).slice(0, 4).map((e) => personName(e.node?.actor)).filter(Boolean),
    countries: (m.countries || []).map((c) => c.localizedName),
    languages: m.languages || [],
    press: m.stats?.pressReview?.score ? Math.round(m.stats.pressReview.score * 10) / 10 : null,
    spect: m.stats?.userRating?.score ? Math.round(m.stats.userRating.score * 10) / 10 : null,
    synopsis: m.synopsis ? decode(m.synopsis.replace(/<[^>]+>/g, '')) : null,
    allocineId: m.internalId,
  };
}

function versionOf(showtime, movie) {
  const tags = showtime.tags || [];
  const french = movie.languages[0] === 'FRENCH';
  if (tags.includes('Localization.Version.Original') || showtime.diffusionVersion === 'ORIGINAL') return french ? 'VF' : 'VO';
  return 'VF';
}

function formatOf(s) {
  const out = new Set();
  for (const t of s.tags || []) {
    if (/IMAX/i.test(t)) out.add('IMAX');
    else if (/4DX/i.test(t)) out.add('4DX');
    else if (/Dolby.?Cinema/i.test(t)) out.add('Dolby Cinema');
    else if (/Dolby.?Atmos/i.test(t)) out.add('Atmos');
    else if (/Projection\.3D/i.test(t)) out.add('3D');
    else if (/70mm/i.test(t)) out.add('70mm');
    else if (/35mm|Film\.35/i.test(t)) out.add('35mm');
    else if (/ScreenX/i.test(t)) out.add('ScreenX');
  }
  return [...out].join(' ');
}

async function showtimesOf(theaterId, date) {
  const results = [];
  for (let page = 1; ; page++) {
    const data = await get(`/_/showtimes/theater-${theaterId}/d-${date}/${page > 1 ? `p-${page}/` : ''}`);
    if (!data || data.error) break;
    results.push(...(data.results || []));
    if (page >= Number(data.pagination?.totalPages || 1)) break;
  }
  return results;
}

// ---------------------------------------------------------------- Main

async function main() {
  const t0 = Date.now();
  await mkdir(dirname(ZONES_CACHE), { recursive: true });
  const zones = JSON.parse(await readFile(ZONES_CACHE, 'utf8').catch(() => '{}'));
  if (zones.v !== 2) Object.assign(zones, { v: 2, theaters: {} }); // purge des listes enregistrées par erreur (v1)
  zones.cities ??= {}; // "nom|codes postaux" → { id, name } | { none: date }
  zones.theaters ??= {}; // id ville Allociné → { at, list }

  const cities = [{ id: PARIS_CITY_ID, name: 'Paris' }];
  if (!PARIS_ONLY) {
    const communes = [...(await Promise.all(DEPARTMENTS.map(communesOf))).flat(), ...EXTRA_CITIES.map(([name, zip]) => ({ name, zips: [zip] }))];
    const key = (c) => `${c.name}|${c.zips.join(',')}`;
    // Entrée en cache : { id, name } ou { none: date } (absente d'Allociné, revérifiée après 30 jours)
    const unknown = communes.filter((c) => {
      const e = zones.cities[key(c)];
      return !e || (e.none && Date.now() - e.none > 30 * 864e5);
    });
    if (unknown.length) console.log(`▸ Résolution de ${unknown.length} communes sur Allociné…`);
    let failed = 0;
    await pool(unknown, CONCURRENCY, async (c) => {
      const r = await resolveCity(c);
      if (r === undefined) failed++;
      else zones.cities[key(c)] = r || { none: Date.now() };
    });
    if (failed) console.warn(`  ✗ ${failed} commune(s) non résolues (réseau), nouvel essai au prochain passage`);
    const seen = new Set();
    for (const c of communes) {
      const city = zones.cities[key(c)];
      if (!city?.id) continue;
      if (city && !seen.has(city.id)) seen.add(city.id) && cities.push(city);
    }
    console.log(`▸ Zones : Paris + ${communes.length} communes (${DEPARTMENTS.join(', ')}${EXTRA_CITIES.length ? ' + extra' : ''}), ${cities.length - 1} connues d'Allociné`);
  }

  // Liste des cinémas par ville (Paris toujours rafraîchi, banlieue selon THEATERS_TTL_DAYS)
  const theaters = {};
  await pool(cities, CONCURRENCY, async (city) => {
    const cached = zones.theaters[city.id];
    const fresh = cached && city.id !== PARIS_CITY_ID && Date.now() - cached.at < THEATERS_TTL_DAYS * 864e5;
    let list = fresh ? cached.list : await theatersOfCity(city);
    if (list === null) list = cached?.list || []; // échec : on garde l'ancienne liste
    else if (!fresh) zones.theaters[city.id] = { at: Date.now(), list };
    for (const t of list) theaters[t.id] ??= t;
  });
  await writeFile(ZONES_CACHE, JSON.stringify(zones));
  const theaterIds = Object.keys(theaters);
  console.log(`▸ ${theaterIds.length} cinémas trouvés`);
  if (args.includes('--zones-only')) {
    const byDept = {};
    for (const t of Object.values(theaters)) byDept[t.dept || '?'] = (byDept[t.dept || '?'] || 0) + 1;
    console.log('  par département :', byDept);
    return;
  }

  const dates = Array.from({ length: DAYS }, (_, i) => isoDay(i));
  const jobs = theaterIds.flatMap((id) => dates.map((date) => ({ id, date })));
  console.log(`▸ Récupération des séances sur ${DAYS} jours (${jobs.length} requêtes)…`);

  const movies = {};
  const showtimes = [];
  const active = new Set();
  let done = 0;

  await pool(jobs, CONCURRENCY, async ({ id, date }) => {
    for (const { movie, showtimes: groups } of await showtimesOf(id, date)) {
      if (!movie) continue;
      const mid = String(movie.internalId);
      movies[mid] ??= movieRecord(movie);
      for (const s of Object.values(groups || {}).flat()) {
        if (!s?.startsAt) continue;
        // 6e champ (facultatif) : 1 si Allociné marque la séance comme avant-première
        showtimes.push([mid, id, s.startsAt.slice(0, 16), versionOf(s, movies[mid]), formatOf(s), ...(s.isPreview ? [1] : [])]);
        active.add(id);
      }
    }
    done++;
    if (done % 50 === 0 || done === jobs.length) process.stdout.write(`\r  ${done}/${jobs.length}`);
  });
  process.stdout.write('\n');

  // Dédoublonnage et tri chronologique
  const uniq = [...new Map(showtimes.map((s) => [s.join('|'), s])).values()].sort((a, b) => a[2].localeCompare(b[2]));
  for (const id of theaterIds) if (!active.has(id)) delete theaters[id];
  await geocodeTheaters(theaters);

  // Notes des autres sites : en parallèle, et jamais bloquantes pour la mise à jour du programme
  const safe = (name, p) => p.catch((err) => console.warn(`  ✗ ${name} : ${err.message}`));
  if (!process.argv.includes('--no-ratings')) {
    await Promise.all([
      safe('SensCritique', addSensCritique(movies)),
      safe('Notes IMDb/Letterboxd/RT/Metacritic', addRatings(movies)),
      safe('Distributions', addFullCast(movies)),
    ]);
  }

  // Garde-fou : si Allociné nous a bloqués, on n'écrase pas les données existantes
  // (en CI, l'échec empêche le déploiement et le site garde la version précédente).
  const minShowtimes = Number(process.env.MIN_SHOWTIMES ?? 50 * DAYS);
  if (uniq.length < minShowtimes) {
    console.error(`✗ Seulement ${uniq.length} séances récupérées (minimum ${minShowtimes}) : blocage probable, fichier non modifié.`);
    process.exit(1);
  }

  // Cartes dont la liste de salles vient d'une source externe
  const cards = {};
  try {
    cards.cinecheque = await cinechequeTheaters(theaters, ['75', ...DEPARTMENTS]);
  } catch (err) {
    console.warn(`  ✗ Cinéchèques : ${err.message}`);
  }

  const programme = { generatedAt: new Date().toISOString(), dates, theaters, movies, showtimes: uniq, cards };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(programme));
  console.log(
    `✓ ${Object.keys(movies).length} films, ${uniq.length} séances, ${Object.keys(theaters).length} cinémas actifs ` +
      `→ public/data/programme.json (${Math.round((Date.now() - t0) / 1000)} s)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
