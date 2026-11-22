#!/usr/bin/env node
// Critiques presse Allociné : média, note, auteur, extrait, lien vers l'article.
// Une page par film ayant une note presse (/film/fichefilm-<id>/critiques/presse/), avec cache
// (.cache/press.json) : les films sortis depuis moins de 5 semaines sont relus tous les 3 jours
// (les critiques s'ajoutent), les autres tous les 60 jours.
// Résultat : public/data/press.json  { <movieId>: [{ m, n, a, t, u }] } — chargé par le site à la demande.
//
// En autonome : node scraper/press.js [--limit 5]   (lit public/data/programme.json)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'press.json');
const OUT = join(ROOT, 'public', 'data', 'press.json');
const PROGRAMME = join(ROOT, 'public', 'data', 'programme.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const DAY = 864e5;
const GAP = 600; // ms entre deux pages (Allociné limite le débit)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function getPage(url) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const wait = last + GAP - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return '';
      if (res.status === 429) { await sleep(Math.min(Number(res.headers.get('retry-after')) || 15 * attempt, 60) * 1000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch {
      await sleep(3000 * attempt);
    }
  }
  return null; // échec : on gardera le cache
}

const decode = (s) =>
  s.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;/g, '’').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Liens masqués par Allociné : classe « ACr… » = base64 de l'URL entrecoupé de « ACr »
function hiddenLink(block) {
  const tok = block.match(/class="(ACr[A-Za-z0-9+/=]+)/)?.[1];
  if (!tok) return null;
  try {
    const url = Buffer.from(tok.replace(/ACr/g, ''), 'base64').toString('utf8');
    return /^https?:\/\//.test(url) ? url : url.startsWith('/') ? 'https://www.allocine.fr' + url : null;
  } catch { return null; }
}

export function parsePress(html) {
  const body = html.slice(html.indexOf('<body'));
  const items = body.split(/<div class="item hred" id="pressreview\d+">/).slice(1);
  return items.map((b) => {
    const media = decode(b.match(/<h2 class="title">([\s\S]*?)<\/h2>/)?.[1] || '');
    const note = Number(b.match(/rating-mdl n(\d{2})/)?.[1]) / 10 || null;
    const author = decode(b.match(/<span class="author">([\s\S]*?)<\/span>/)?.[1] || '').replace(/^par\s+/i, '') || null;
    const text = decode(b.match(/<p class="text">([\s\S]*?)<\/p>/)?.[1] || '');
    const linkBlock = b.match(/La critique complète est disponible[\s\S]*?<\/span>/)?.[0] || '';
    return { m: media, n: note, a: author, t: text, u: hiddenLink(linkBlock) };
  }).filter((r) => r.m && r.t);
}

export async function fetchPress(movies, { limit = Infinity } = {}) {
  await mkdir(dirname(CACHE), { recursive: true });
  const cache = JSON.parse(await readFile(CACHE, 'utf8').catch(() => '{}'));
  const now = Date.now();
  const list = Object.entries(movies).filter(([, m]) => m.press).slice(0, limit);
  const recent = (m) => m.release && now - new Date(m.release) < 35 * DAY;
  let fetched = 0, failed = 0;

  for (const [, m] of list) {
    const c = cache[m.allocineId];
    if (c && now - c.at < (recent(m) ? 3 : 60) * DAY) continue;
    const html = await getPage(`https://www.allocine.fr/film/fichefilm-${m.allocineId}/critiques/presse/`);
    if (html === null) { failed++; continue; }
    cache[m.allocineId] = { at: now, reviews: html ? parsePress(html) : [] };
    fetched++;
  }
  await writeFile(CACHE, JSON.stringify(cache));

  const out = {};
  for (const [id, m] of list) {
    const r = cache[m.allocineId]?.reviews;
    if (r?.length) out[id] = r;
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`▸ Critiques presse : ${Object.keys(out).length}/${list.length} films (${fetched} pages lues${failed ? `, ${failed} échecs` : ''})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--limit');
  const p = JSON.parse(await readFile(PROGRAMME, 'utf8'));
  await fetchPress(p.movies, { limit: i > 0 ? Number(process.argv[i + 1]) : Infinity });
}
