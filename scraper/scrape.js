#!/usr/bin/env node
// Récupère le programme des cinémas de Paris (+ proche banlieue) depuis Allociné
// et écrit public/data/programme.json, consommé par l'interface.
//
// Usage : node scraper/scrape.js [--days 7] [--paris-only]

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARIS_CITY_ID, SUBURBS, DEFAULT_DAYS, CONCURRENCY } from './config.js';
import { geocodeTheaters } from './geocode.js';
import { addSensCritique } from './senscritique.js';
import { addRatings } from './ratings.js';

const BASE = 'https://www.allocine.fr';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'programme.json');

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
      if (res.status === 404) return null;
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

async function resolveCity([name, zipPrefix]) {
  const data = await get(`/_/localization_city/${encodeURIComponent(name)}`);
  const cities = (data?.values?.cities || []).map((c) => c.node).filter((c) => String(c.zip).startsWith(zipPrefix));
  const city = cities.find((c) => norm(c.name) === norm(name)) || cities.find((c) => norm(c.name).startsWith(norm(name).slice(0, 8)));
  if (!city) console.warn(`  ? ville introuvable : ${name}`);
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
    if (!html) break;
    const cards = html.split('class="theater-card').slice(1);
    const before = found.length;
    for (const card of cards) {
      const meta = card.match(/data-theater="([^"]+)"/);
      if (!meta) continue;
      const { id, name } = JSON.parse(decode(meta[1]));
      const address = decode(card.match(/<address[^>]*>([^<]*)<\/address>/)?.[1] || '');
      const screens = Number(card.match(/screen-number">\s*(\d+)/)?.[1]) || null;
      if (!found.some((t) => t.id === id)) found.push({ id, name: decode(name), address, screens, area: areaOf(address, city.name) });
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
  console.log(`▸ Zones : Paris${PARIS_ONLY ? '' : ` + ${SUBURBS.length} villes de banlieue`}`);
  const cities = [{ id: PARIS_CITY_ID, name: 'Paris' }];
  if (!PARIS_ONLY) cities.push(...(await pool(SUBURBS, CONCURRENCY, resolveCity)).filter(Boolean));

  const theaters = {};
  for (const list of await pool(cities, CONCURRENCY, theatersOfCity)) {
    for (const t of list) theaters[t.id] ??= t;
  }
  const theaterIds = Object.keys(theaters);
  console.log(`▸ ${theaterIds.length} cinémas trouvés`);

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
        showtimes.push([mid, id, s.startsAt.slice(0, 16), versionOf(s, movies[mid]), formatOf(s)]);
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
    await Promise.all([safe('SensCritique', addSensCritique(movies)), safe('Notes IMDb/Letterboxd/RT/Metacritic', addRatings(movies))]);
  }

  // Garde-fou : si Allociné nous a bloqués, on n'écrase pas les données existantes
  // (en CI, l'échec empêche le déploiement et le site garde la version précédente).
  const minShowtimes = Number(process.env.MIN_SHOWTIMES ?? 50 * DAYS);
  if (uniq.length < minShowtimes) {
    console.error(`✗ Seulement ${uniq.length} séances récupérées (minimum ${minShowtimes}) : blocage probable, fichier non modifié.`);
    process.exit(1);
  }

  const programme = { generatedAt: new Date().toISOString(), dates, theaters, movies, showtimes: uniq };
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
