#!/usr/bin/env node
// Met à jour la table des salles (scraper/salles.json) à compléter à la main :
//   node scraper/salles.js
// Ajoute les salles rencontrées dans les séances en ligne (data/seances.json du site) sans jamais
// modifier ce qui a déjà été saisi. Pour chaque salle :
//   places : nombre de places (pré-rempli avec la capacité officielle Pathé quand elle est connue)
//   ecran  : taille de l'écran, texte libre (ex. « 12 m » ou « 12 × 5 m »)
//   estime : (information) capacité estimée automatiquement (MK2), à confirmer dans « places »
// Les valeurs saisies priment sur les données automatiques lors de la mise à jour de la nuit.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roomKey } from './seances.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'scraper', 'salles.json');
const SITE = process.env.SITE || 'https://luclucluc.github.io/paris-cine/data';

const get = async (name) => {
  const res = await fetch(`${SITE}/${name}`);
  if (!res.ok) throw new Error(`${name} : HTTP ${res.status}`);
  return res.json();
};

const [programme, seances] = await Promise.all([get('programme.json'), get('seances.json')]);
const table = JSON.parse(await readFile(FILE, 'utf8').catch(() => '{}'));
let added = 0;

for (const [key, x] of Object.entries(seances)) {
  if (!x.r) continue;
  const tid = key.split('|')[1];
  const theater = programme.theaters[tid];
  if (!theater) continue;
  const rooms = (table[tid] ??= { _nom: theater.name });
  const name = Object.keys(rooms).find((n) => roomKey(n) === roomKey(x.r));
  if (!name) {
    rooms[x.r] = { places: x.c && !x.ce ? x.c : null, ecran: null, ...(x.ce ? { estime: x.c } : {}) };
    added++;
  } else if (x.ce && x.c > (rooms[name].estime || 0) && !rooms[name].places) {
    rooms[name].estime = x.c; // estimation MK2 affinée
  }
}

// Tri : cinémas par nom, salles dans l'ordre naturel (Salle 2 avant Salle 10)
const nat = (a, b) => a.localeCompare(b, 'fr', { numeric: true });
const sorted = Object.fromEntries(
  Object.entries(table)
    .sort(([, a], [, b]) => nat(a._nom || '', b._nom || ''))
    .map(([tid, rooms]) => [tid, Object.fromEntries(Object.entries(rooms).sort(([a], [b]) => (a === '_nom' ? -1 : b === '_nom' ? 1 : nat(a, b))))])
);
// Une ligne par salle, pour une saisie facile
const J = JSON.stringify;
const text = `{\n${Object.entries(sorted).map(([tid, rooms]) =>
  `  ${J(tid)}: {\n${Object.entries(rooms).map(([k, v]) => `    ${J(k)}: ${J(v).replace(/,"/g, ', "').replace(/":/g, '": ')}`).join(',\n')}\n  }`).join(',\n')}\n}\n`;
JSON.parse(text); // garde-fou
await writeFile(FILE, text);
const total = Object.values(sorted).reduce((n, r) => n + Object.keys(r).length - 1, 0);
console.log(`✓ ${added} salles ajoutées · ${Object.keys(sorted).length} cinémas, ${total} salles → scraper/salles.json`);
