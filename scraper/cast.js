#!/usr/bin/env node
// Distribution complète des films (Wikidata, propriété P161 « distribution »), en plus des
// 3 premiers acteurs fournis par Allociné. Sert à la recherche et au masquage par acteur ;
// l'affichage reste limité aux acteurs principaux.
//
// Une requête groupée, avec cache (.cache/cast.json) : distribution rafraîchie tous les 7 jours
// pour les films récents (Wikidata se complète au fil des semaines), tous les 60 jours sinon.
//
// En autonome : node scraper/cast.js  (enrichit public/data/programme.json)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'cast.json');
const PROGRAMME = join(ROOT, 'public', 'data', 'programme.json');
const UA = 'paris-cine/0.1 (+https://github.com/luclucluc/paris-cine)';
const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

async function wikidataCast(allocineIds) {
  const out = new Map(allocineIds.map((id) => [id, []]));
  // Par lots, pour garder des requêtes raisonnables
  for (let i = 0; i < allocineIds.length; i += 300) {
    const batch = allocineIds.slice(i, i + 300);
    const query = `SELECT ?allo ?p ?name WHERE {
      VALUES ?allo { ${batch.map((id) => `"${id}"`).join(' ')} }
      ?f wdt:P1265 ?allo ; wdt:P161 ?p . ?p rdfs:label ?name . FILTER(LANG(?name) IN ("fr", "mul", "en"))
    }`;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch('https://query.wikidata.org/sparql', {
          method: 'POST',
          headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ query }),
          signal: AbortSignal.timeout(90000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Un libellé par personne : français, sinon multilingue, sinon anglais
        const rank = { fr: 0, mul: 1, en: 2 };
        const best = new Map(); // allo|p → { name, r }
        for (const b of (await res.json()).results.bindings) {
          const k = `${b.allo.value}|${b.p.value}`;
          const r = rank[b.name['xml:lang']] ?? 9;
          if (!best.has(k) || r < best.get(k).r) best.set(k, { name: b.name.value, r });
        }
        for (const [k, { name }] of best) out.get(k.split('|')[0])?.push(name);
        break;
      } catch (err) {
        if (attempt >= 4) { console.warn(`  ✗ Wikidata (distributions) : ${err.message}`); break; }
        await sleep(10000 * attempt);
      }
    }
  }
  return out;
}

export async function addFullCast(movies) {
  await mkdir(dirname(CACHE), { recursive: true });
  const cache = JSON.parse(await readFile(CACHE, 'utf8').catch(() => '{}'));
  const now = Date.now();
  const list = Object.values(movies);
  const recent = (m) => m.release && now - new Date(m.release) < 90 * DAY;
  const todo = list.filter((m) => {
    const c = cache[m.allocineId];
    return !c || now - c.at > (recent(m) ? 7 : 60) * DAY;
  });

  if (todo.length) {
    const found = await wikidataCast(todo.map((m) => String(m.allocineId)));
    for (const m of todo) {
      const names = found.get(String(m.allocineId));
      if (names) cache[m.allocineId] = { names: names.sort(), at: now };
    }
    await writeFile(CACHE, JSON.stringify(cache));
  }

  let withMore = 0;
  for (const m of list) {
    const known = new Set([...m.directors, ...m.cast].map(fold));
    const more = (cache[m.allocineId]?.names || []).filter((n) => !known.has(fold(n)));
    if (more.length) { m.more = more; withMore++; }
  }
  console.log(`▸ Distributions complètes (Wikidata) : ${withMore} films enrichis (${todo.length} interrogés)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = JSON.parse(await readFile(PROGRAMME, 'utf8'));
  await addFullCast(p.movies);
  await writeFile(PROGRAMME, JSON.stringify(p));
  console.log('✓ programme.json mis à jour');
}
