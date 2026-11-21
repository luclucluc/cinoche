#!/usr/bin/env node
// Géocode les adresses des cinémas via la Base Adresse Nationale (Géoplateforme IGN, gratuite, sans clé).
// Les résultats sont mis en cache dans scraper/geo-cache.json : seule une nouvelle salle ou une adresse
// modifiée déclenche une requête.
//
// Utilisé automatiquement par scrape.js. En autonome : node scraper/geocode.js
// (ajoute lat/lon au public/data/programme.json existant).

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, 'geo-cache.json');
const PROGRAMME = join(HERE, '..', 'public', 'data', 'programme.json');
const BAN_CSV = 'https://data.geopf.fr/geocodage/search/csv';

// Emprise large de l'Île-de-France, pour écarter les résultats aberrants
const inIDF = (lat, lon) => lat > 48.1 && lat < 49.25 && lon > 1.4 && lon < 3.6;

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;

export async function geocodeTheaters(theaters) {
  const cache = JSON.parse(await readFile(CACHE, 'utf8').catch(() => '{}'));
  const todo = Object.values(theaters).filter((t) => t.address && cache[t.id]?.address !== t.address);

  if (todo.length) {
    const csv = 'id,address\n' + todo.map((t) => `${csvCell(t.id)},${csvCell(t.address)}`).join('\n');
    const form = new FormData();
    form.append('data', new Blob([csv], { type: 'text/csv' }), 'cinemas.csv');
    form.append('columns', 'address');
    try {
      const res = await fetch(BAN_CSV, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const r of parseCSV(await res.text())) {
        const lat = Number(r.latitude), lon = Number(r.longitude);
        cache[r.id] = inIDF(lat, lon) ? { address: theaters[r.id].address, lat, lon } : { address: theaters[r.id].address, lat: null, lon: null };
      }
      await writeFile(CACHE, JSON.stringify(cache, null, 1));
    } catch (err) {
      console.warn(`  ✗ géocodage impossible : ${err.message}`);
    }
  }

  let missing = 0;
  for (const t of Object.values(theaters)) {
    const g = cache[t.id];
    t.lat = g?.lat ?? null;
    t.lon = g?.lon ?? null;
    if (t.lat == null) missing++;
  }
  console.log(`▸ Géocodage : ${todo.length} nouvelle(s) adresse(s), ${missing} cinéma(s) sans coordonnées`);
  return theaters;
}

// Exécution autonome
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = JSON.parse(await readFile(PROGRAMME, 'utf8'));
  await geocodeTheaters(p.theaters);
  await writeFile(PROGRAMME, JSON.stringify(p));
  console.log('✓ programme.json mis à jour');
}
