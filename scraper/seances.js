#!/usr/bin/env node
// Détails des séances, chargés par le site à l'ouverture de la fiche d'une séance :
//  - lien de réservation directe (fourni par Allociné pour la plupart des cinémas) ;
//  - Pathé / Gaumont : salle, capacité (officielle) et heure de fin, via l'API de pathe.fr ;
//  - UGC : salle et heure de fin, lues sur la page de réservation de chaque séance. UGC n'y indique la
//    salle que le jour même : seules les séances du jour sont lues (environ 1 000 pages, avec cache) ;
//  - MK2 : salle et capacité estimée (plus grand nombre de places libres vu sur une séance de la salle).
// Les séances sont reliées à celles d'Allociné par le code de réservation présent dans les deux liens.
//
// Résultat : public/data/seances.json  { "<film>|<cinéma>|<AAAA-MM-JJTHH:MM>|<VO|VF>": { u, r?, c?, e?, ce? } }
//   u : lien de réservation · r : salle · c : places · ce : 1 si la capacité est estimée · e : heure de fin

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data', 'seances.json');
const UGC_CACHE = join(ROOT, '.cache', 'ugc-rooms.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const ZIPS = /^(75|92|93|94)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch {
      await sleep(2000 * attempt);
    }
  }
  return null;
}
async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// Lien de réservation sans les paramètres de suivi (utm_*, mtm_*, partenaire…)
export function cleanTicketUrl(raw) {
  try {
    const u = new URL(raw.replace('://s.pathe.fr/en/', '://s.pathe.fr/fr/'));
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|mtm_)|^(partenaire|part)$/.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\?(#|$)/, '$1');
  } catch { return null; }
}

// Meilleur lien d'une séance Allociné (le relais « relay » d'Allociné en dernier recours)
export function ticketOf(showtime) {
  const t = showtime?.data?.ticketing || [];
  const url = (t.find((x) => x.provider !== 'relay') || t[0])?.urls?.[0];
  return url ? cleanTicketUrl(url) : null;
}

const hhmm = (s) => (s || '').match(/(\d{2}:\d{2})/)?.[1] || null;

// ------------------------------------------------------------------ Pathé

async function patheRooms(dates) {
  const out = new Map(); // code de réservation (V…S…) → { r, c, e }
  const cinemas = ((await getJson('https://www.pathe.fr/api/cinemas?language=fr')) || []).filter((c) => c.theaters?.some((t) => ZIPS.test(t.addressZip || '')));
  const jobs = [];
  for (const c of cinemas) {
    const shows = (await getJson(`https://www.pathe.fr/api/cinema/${c.slug}/shows?language=fr`))?.shows || {};
    for (const [show, v] of Object.entries(shows)) for (const d of Object.keys(v.days || {})) if (dates.includes(d)) jobs.push([show, c.slug, d]);
  }
  await pool(jobs, 4, async ([show, cinema, d]) => {
    const list = await getJson(`https://www.pathe.fr/api/show/${show}/showtimes/${cinema}/${d}?language=fr`);
    for (const s of Array.isArray(list) ? list : []) {
      const code = s.refCmd?.match(/\/(V\d+S\d+)\//)?.[1];
      if (!code) continue;
      const name = String(s.auditoriumName || '').trim();
      out.set(code, { r: name ? (/^\d+$/.test(name) ? `Salle ${name}` : name) : undefined, c: Number(s.auditoriumCapacity) || undefined, e: hhmm(s.endTime) || undefined });
    }
  });
  console.log(`  Pathé : ${cinemas.length} cinémas, ${jobs.length} requêtes, ${out.size} séances`);
  return out;
}

// ------------------------------------------------------------------ MK2

async function mk2Rooms() {
  const out = new Map(); // "cinemaId|sessionId" → { r, c, ce }
  const complexes = (await getJson('https://prod-paris-cf.api.mk2.com/cinema-complex'))?.data || [];
  const sessions = [];
  await pool(complexes, 2, async (c) => {
    sessions.push(...((await getJson(`https://prod-paris-cf.api.mk2.com/cinema-complex/${c.slug}/sessions`))?.sessions || []));
  });
  // Capacité estimée : le plus grand nombre de places libres observé pour la salle
  const cap = new Map();
  for (const s of sessions) {
    const k = `${s.cinemaId}|${s.screenNumber}`;
    cap.set(k, Math.max(cap.get(k) || 0, Number(s.seatsAvailable) || 0));
  }
  for (const s of sessions) {
    const room = String(s.screenName || '').trim().toLowerCase().replace(/^\w/, (x) => x.toUpperCase());
    out.set(`${s.cinemaId}|${s.sessionId}`, { r: room || undefined, c: cap.get(`${s.cinemaId}|${s.screenNumber}`) || undefined, ce: 1 });
  }
  console.log(`  MK2 : ${complexes.length} complexes, ${out.size} séances`);
  return out;
}

// ------------------------------------------------------------------ UGC

export function parseUgc(html) {
  const r = html.match(/class="screen-informations">\s*<span[^>]*>([^<]+)</)?.[1]?.trim();
  const e = html.match(/\(fin (\d{2}:\d{2})\)/)?.[1];
  return r ? { r: r.replace(/^salle/i, 'Salle'), ...(e ? { e } : {}) } : null;
}

async function ugcRooms(ids) {
  await mkdir(dirname(UGC_CACHE), { recursive: true });
  const cache = JSON.parse(await readFile(UGC_CACHE, 'utf8').catch(() => '{}'));
  const todo = ids.filter((id) => !(id in cache));
  let failed = 0;
  await pool(todo, 3, async (id) => {
    try {
      const res = await fetch(`https://www.ugc.fr/reservationSeances.html?id=${id}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) { failed++; if (res.status === 429) await sleep(30000); return; }
      const info = parseUgc(await res.text());
      if (info) cache[id] = info; // sans salle : nouvel essai à la prochaine mise à jour
    } catch { failed++; }
    await sleep(150);
  });
  // On ne garde que les séances encore au programme
  const keep = Object.fromEntries(ids.filter((id) => id in cache).map((id) => [id, cache[id]]));
  await writeFile(UGC_CACHE, JSON.stringify(keep));
  console.log(`  UGC : ${ids.length} séances, ${todo.length} pages lues${failed ? `, ${failed} échecs` : ''}`);
  return new Map(Object.entries(keep));
}

// ------------------------------------------------------------------ Assemblage

/** @param tickets Map clé de séance → lien de réservation ; @param dates jours couverts (AAAA-MM-JJ) */
export async function fetchSeances(tickets, dates) {
  const today = dates[0];
  const ugcIds = [...new Set([...tickets].filter(([k]) => k.split('|')[2].startsWith(today)).map(([, u]) => u.match(/ugc\.fr\/reservationSeances\.html\?id=(\d+)/)?.[1]).filter(Boolean))];
  const [pathe, mk2, ugc] = await Promise.all([
    patheRooms(dates).catch((err) => (console.warn(`  ✗ Pathé : ${err.message}`), new Map())),
    mk2Rooms().catch((err) => (console.warn(`  ✗ MK2 : ${err.message}`), new Map())),
    ugcRooms(ugcIds).catch((err) => (console.warn(`  ✗ UGC : ${err.message}`), new Map())),
  ]);
  const out = {};
  let rooms = 0;
  for (const [key, u] of tickets) {
    const e = { u };
    let extra = null;
    const pc = u.match(/pathe\.fr\/\w+\/(V\d+S\d+)\//)?.[1];
    if (pc) extra = pathe.get(pc);
    const mk = u.match(/mk2\.com\/.*cinemaId=(\d+)&sessionId=(\d+)/);
    if (mk) extra = mk2.get(`${mk[1]}|${mk[2]}`);
    const ug = u.match(/ugc\.fr\/reservationSeances\.html\?id=(\d+)/)?.[1];
    if (ug) extra = ugc.get(ug);
    if (extra) { for (const [k, v] of Object.entries(extra)) if (v !== undefined) e[k] = v; rooms++; }
    out[key] = e;
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`▸ Détails des séances : ${Object.keys(out).length} liens de réservation, ${rooms} avec la salle`);
}
