// Paris Ciné — interface. Données : data/programme.json (généré par scraper/scrape.js)
// Format d'une séance : [movieId, theaterId, "YYYY-MM-DDTHH:MM", "VO"|"VF", formats]

import { CineMap, distance, fmtDistance, searchAddress } from './map.js';
import { CARDS, acceptsCard } from './cards.js';
import { CHAINS, chainOf } from './chains.js';

const $ = (s) => document.querySelector(s);
const POSTER = (p) => (p ? `https://fr.web.img3.acsta.net/c_160_213${p}` : '');
const FILM_URL = (id) => `https://www.allocine.fr/film/fichefilm_gen_cfilm=${id}.html`;
const CINE_URL = (id) => `https://www.allocine.fr/seance/salle_gen_csalle=${id}.html`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('pc.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem('pc.' + k, JSON.stringify(v)),
};

// ------------------------------------------------------------------ Notes

// Ordre et présentation des notes (comme paris-cine.info)
const RATINGS = [
  { key: 'imdb', label: 'IMDb', title: 'Note IMDb (/10)', fmt: (v) => v.toFixed(1), hi: 7.5, url: (m) => m.imdbId && `https://www.imdb.com/title/${m.imdbId}/` },
  { key: 'press', label: 'Presse', title: 'Note presse Allociné (/5)', fmt: (v) => v.toFixed(1), hi: 4, url: (m) => FILM_URL(m.allocineId) },
  { key: 'spect', label: 'Spect.', title: 'Note spectateurs Allociné (/5)', fmt: (v) => v.toFixed(1), hi: 4, url: (m) => FILM_URL(m.allocineId) },
  { key: 'sc', label: 'SensCritique', short: 'SC', title: 'Note SensCritique (/10)', fmt: (v) => v.toFixed(1), hi: 7.5, url: (m) => m.scUrl },
  { key: 'lb', label: 'Letterboxd', short: 'LB', title: 'Note Letterboxd (/5)', fmt: (v) => v.toFixed(1), hi: 3.8, url: (m) => m.lbUrl },
  { key: 'mc', label: 'Metacritic', short: 'MC', title: 'Metascore (/100)', fmt: (v) => String(v), hi: 75, url: (m) => m.mcUrl },
  { key: 'rt', label: 'Rotten T.', short: 'RT', title: 'Tomatometer (% de critiques positives)', fmt: (v) => v + '%', hi: 90, url: (m) => m.rtUrl },
];

// ------------------------------------------------------------------ Filtres

const LANG = {
  ENGLISH: 'Anglais', FRENCH: 'Français', SPANISH: 'Espagnol', ITALIAN: 'Italien', GERMAN: 'Allemand', JAPANESE: 'Japonais',
  KOREAN: 'Coréen', CHINESE: 'Chinois', MANDARIN: 'Mandarin', CANTONESE: 'Cantonais', ARABIC: 'Arabe', PORTUGUESE: 'Portugais',
  RUSSIAN: 'Russe', POLISH: 'Polonais', CZECH: 'Tchèque', HINDI: 'Hindi', PERSIAN: 'Persan', TURKISH: 'Turc', HEBREW: 'Hébreu',
  GREEK: 'Grec', SWEDISH: 'Suédois', DANISH: 'Danois', NORWEGIAN: 'Norvégien', DUTCH: 'Néerlandais', FINNISH: 'Finnois',
  HUNGARIAN: 'Hongrois', ROMANIAN: 'Roumain', UKRAINIAN: 'Ukrainien', SILENT: 'Muet', TAMIL: 'Tamoul', THAI: 'Thaï',
};
const langLabel = (l) => LANG[l] || (l ? l[0] + l.slice(1).toLowerCase() : 'Inconnue');
const FORMAT_RE = /Dolby Cinema|IMAX|4DX|ScreenX|Atmos|3D|70mm|35mm/g;
const FORMAT_LABEL = { Atmos: 'Dolby Atmos' };
const formatsOf = (s) => (s[4] ? s[4].match(FORMAT_RE) || [] : []);

const DEPTS = { 92: 'Hauts-de-Seine', 93: 'Seine-Saint-Denis', 94: 'Val-de-Marne' };

const HOURS = [
  ['0', 'Toutes'],
  ['now', 'À partir de maintenant'],
  ['m', 'Matin (avant 12 h)'],
  ['a', 'Après-midi (12 h – 18 h)'],
  ['18', 'Après 18 h'],
  ['20', 'Après 20 h'],
  ['22', 'Après 22 h'],
];
const sortOptions = () => [
  ['copies', 'Plus de cinémas'],
  ...visibleRatings().map((r) => [r.key, `Note ${r.label}`]),
  ['release', 'Sortie récente'],
  ['year', 'Année (récent → ancien)'],
  ['title', 'Titre A → Z'],
];
// Notes affichées (réglable dans Compte) ; toutes par défaut
const visibleRatings = () => RATINGS.filter((r) => state.showRatings.has(r.key));

const state = {
  tab: 'all',
  view: 'films',
  date: null, // 'YYYY-MM-DD' ou 'week'
  version: store.get('version', ''),
  hours: '0',
  zone: store.get('zone', ''),
  cinemas: new Set(store.get('cinemas', [])),
  cards: new Set(store.get('cards', [])),
  langs: new Set(),
  genres: new Set(),
  formats: new Set(),
  sort: 'copies',
  q: '',
  favs: new Set(store.get('favs', [])),
  hiddenPeople: new Set(store.get('hiddenPeople', [])), // acteurs / réalisateurs masqués
  hiddenChains: new Set(store.get('hiddenChains', [])), // enseignes masquées
  showRatings: new Set(store.get('ratings', RATINGS.map((r) => r.key))), // notes affichées
  open: new Set(),
  geo: store.get('geo', null), // { lat, lon, label } — reste dans ce navigateur
  radius: store.get('radius', 2000),
  selected: null,
};

let cineMap = null;
const hasCoords = (t) => t.lat != null && t.lon != null;
const dist = (t) => (state.geo && hasCoords(t) ? distance(state.geo, t) : null);

let P; // programme
let OPTIONS = {}; // valeurs possibles des filtres multiples

// ------------------------------------------------------------------ Démarrage

init();

async function init() {
  applyTheme(store.get('theme', null));
  new ResizeObserver(([e]) => document.documentElement.style.setProperty('--header-h', e.target.offsetHeight + 'px')).observe($('.top'));
  try {
    const res = await fetch('data/programme.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    P = await res.json();
  } catch {
    $('#empty').textContent = 'Aucune donnée — lancez npm run scrape';
    $('#empty').hidden = false;
    return;
  }
  for (const [id, m] of Object.entries(P.movies)) {
    m.id = id;
    m._q = fold([m.title, m.originalTitle, ...m.directors, ...m.cast].join(' '));
    m.lang = m.languages?.[0] || '';
  }
  for (const [id, t] of Object.entries(P.theaters)) {
    t.id = id;
    t._q = fold(t.name + ' ' + t.area);
    t.chain = chainOf(t);
    t.dept ??= t.address.match(/\b(75|9[1-5])\d{3}\b/)?.[1] || (t.area.startsWith('Paris ') ? '75' : null);
  }
  const today = parisNow().date;
  state.date = P.dates.includes(today) ? today : P.dates[0];
  // Ne garder que des cinémas encore présents
  for (const id of state.cinemas) if (!P.theaters[id]) state.cinemas.delete(id);

  const count = (arr) => [...arr.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  const shown = new Set(P.showtimes.map((s) => s[0]));
  const films = [...shown].map((id) => P.movies[id]);
  OPTIONS = {
    langs: count(films.map((m) => m.lang).filter(Boolean)),
    genres: count(films.flatMap((m) => m.genres)),
    formats: count(P.showtimes.flatMap(formatsOf)),
  };

  readHash();
  buildDays();
  bindControls();
  $('#updated').textContent = `Mis à jour le ${new Date(P.generatedAt).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}`;
  render();
}

function parisNow() {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [date, time] = parts.split(' ');
  return { date, time };
}

const dayLabel = (d, today = parisNow().date) => {
  const dt = new Date(d + 'T12:00:00');
  const diff = Math.round((dt - new Date(today + 'T12:00:00')) / 864e5);
  return diff === 0 ? 'Aujourd’hui' : dt.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: diff > 6 ? 'short' : undefined });
};

// ------------------------------------------------------------------ Contrôles

function buildDays() {
  $('#days').innerHTML =
    P.dates.map((d) => `<button role="tab" data-date="${d}">${dayLabel(d)}</button>`).join('') +
    `<button role="tab" data-date="week">Toute la semaine</button>`;
}

// Définition des filtres en « puces » avec liste déroulante
const FILTERS = {
  hours: { label: 'Heures', single: true, options: () => HOURS, value: () => state.hours, set: (v) => (state.hours = v), def: '0' },
  zone: {
    label: 'Lieu',
    single: true,
    options: () => {
      const areas = [...new Set(Object.values(P.theaters).map((t) => t.area))];
      const arr = areas.filter((a) => a.startsWith('Paris ')).sort((a, b) => parseInt(a.slice(6)) - parseInt(b.slice(6)));
      const out = [
        ['', 'Paris & petite couronne'],
        ['@paris', 'Paris intra-muros'],
        ['@banlieue', 'Petite couronne (92, 93, 94)'],
        { group: 'Arrondissements' },
        ...arr.map((a) => [a, a]),
      ];
      for (const [d, name] of Object.entries(DEPTS)) {
        const cities = [...new Set(Object.values(P.theaters).filter((t) => t.dept === d).map((t) => t.area))].sort((a, b) => a.localeCompare(b, 'fr'));
        if (!cities.length) continue;
        out.push({ group: `${name} (${d})` }, ['@' + d, `Tout le ${name}`], ...cities.map((c) => [c, c]));
      }
      return out;
    },
    value: () => state.zone,
    set: (v) => { state.zone = v; store.set('zone', v); },
    def: '',
    short: (v) => ({ '': 'Paris & petite couronne', '@paris': 'Paris', '@banlieue': 'Petite couronne', '@near': `${fmtDistance(state.radius)} autour de ${state.geo?.label || '…'}` })[v] ?? (DEPTS[v.slice(1)] || v),
  },
  cinemas: {
    label: 'Cinémas',
    search: true,
    options: () => {
      const all = Object.values(P.theaters).filter((t) => !isHiddenTheater(t)).sort(byPlace);
      const favs = all.filter((t) => state.favs.has(t.id));
      const out = [];
      if (favs.length) out.push({ group: '★ Mes favoris', action: 'favs' }, ...favs.map((t) => [t.id, t.name, t.area]));
      let g = null;
      for (const t of all) {
        if (t.area !== g) out.push({ group: (g = t.area) });
        out.push([t.id, t.name, t.area]);
      }
      return out;
    },
    set: () => store.set('cinemas', [...state.cinemas]),
    plural: 'cinémas',
  },
  cards: {
    label: 'Cartes',
    options: () => CARDS.map((c) => [c.id, c.label]),
    set: () => store.set('cards', [...state.cards]),
    none: 'Aucune',
    note: 'UGC Illimité : salles UGC et MK2 ; CinéPass : Pathé ; CIP : les 32 salles adhérentes ; Cinéchèques : liste officielle cinecheque.fr.',
  },
  langs: { label: 'Langues', options: () => OPTIONS.langs.map((l) => [l, langLabel(l)]), none: 'Toutes', note: 'Langue originale du film.' },
  genres: { label: 'Genres', options: () => OPTIONS.genres.map((g) => [g, g]) },
  formats: { label: 'Format', options: () => OPTIONS.formats.map((f) => [f, FORMAT_LABEL[f] || f]) },
  sort: { label: 'Tri', single: true, options: sortOptions, value: () => state.sort, set: (v) => (state.sort = v), def: 'copies', neutral: true },
};

function chipText(key) {
  const f = FILTERS[key];
  if (f.single) {
    const v = f.value();
    const opt = f.options().find((o) => Array.isArray(o) && o[0] === v);
    return `${f.label} : ${f.short ? f.short(v) : opt ? opt[1] : v}`;
  }
  const set = state[key];
  if (!set.size) return `${f.label} : ${f.none || 'Tous'}`;
  const labels = f.options().filter((o) => Array.isArray(o) && set.has(o[0])).map((o) => o[1]);
  const uniq = [...new Set(labels)];
  return `${f.label} : ${uniq.length === 1 ? uniq[0] : `${uniq.length} ${f.plural || 'choix'}`}`;
}
const isActive = (key) => {
  const f = FILTERS[key];
  return f.neutral ? false : f.single ? f.value() !== f.def : state[key].size > 0;
};

let popKey = null;
function openPop(key, chip) {
  const pop = $('#pop');
  if (popKey === key) return closePop();
  popKey = key;
  const f = FILTERS[key];
  const opts = f.options();
  const seen = new Set();
  const rows = opts
    .map((o) => {
      if (!Array.isArray(o)) {
        return `<li class="pop-group">${esc(o.group)}${o.action === 'favs' ? ' <button class="link" data-action="favs">tout cocher</button>' : ''}</li>`;
      }
      const [v, label, hint] = o;
      const dup = seen.has(v);
      seen.add(v);
      const on = f.single ? f.value() === v : state[key].has(v);
      return `<li><label class="pop-opt${dup ? ' dup' : ''}" data-q="${esc(fold(label + ' ' + (hint || '')))}">
        <input type="${f.single ? 'radio' : 'checkbox'}" name="pop-${key}" value="${esc(v)}" ${on ? 'checked' : ''} />
        <span>${esc(label)}</span></label></li>`;
    })
    .join('');
  pop.innerHTML =
    `<div class="pop-head"><b>${esc(f.label)}</b>${f.single ? '' : '<button class="link" data-action="clear">Effacer</button>'}</div>` +
    (key === 'zone' ? nearBlock() : '') +
    (f.search ? `<input class="pop-search" type="search" placeholder="Rechercher…" />` : '') +
    (f.note ? `<p class="pop-note">${esc(f.note)}</p>` : '') +
    `<ul class="pop-list">${rows}</ul>`;
  pop.hidden = false;
  const inline = !!chip.closest('.sidebar');
  pop.classList.toggle('inline', inline);
  if (inline) {
    chip.after(pop);
    pop.style.left = pop.style.top = '';
  } else {
    document.body.append(pop);
    const r = chip.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 12);
    pop.style.left = Math.max(12, left) + 'px';
    pop.style.top = r.bottom + 6 + 'px';
  }
  for (const c of document.querySelectorAll('.chip')) c.classList.toggle('open', c === chip);
  pop.querySelector('.pop-search')?.focus();
}
// Bloc « Autour de… » du filtre Lieu : point (position ou adresse) + distance
const RADII = [500, 1000, 2000, 3000, 5000, 10000];
let nearResults = [], nearMsg = '';
function nearBlock() {
  const on = state.zone === '@near';
  return `<div class="pop-near${on ? ' on' : ''}">
    <p class="pop-near-title">Autour de : <b>${state.geo ? esc(state.geo.label) : 'aucun point'}</b></p>
    <div class="pop-near-row">
      <button class="btn" data-action="locate">Ma position</button>
      <div class="pop-addr-wrap"><input class="pop-addr" type="search" placeholder="ou une adresse…" autocomplete="off" /><ul class="suggest pop-addr-list" hidden></ul></div>
    </div>
    <div class="seg pop-radius">${RADII.map((r) => `<button data-action="radius" data-r="${r}" class="${on && state.radius === r ? 'on' : ''}">${fmtDistance(r)}</button>`).join('')}</div>
    ${nearMsg ? `<p class="pop-note">${esc(nearMsg)}</p>` : ''}
  </div>`;
}
function reopenPop(key) {
  const chip = document.querySelector(`.chip[data-f="${key}"]`);
  closePop();
  render();
  openPop(key, chip);
}
function useNear(geo) {
  if (geo) { state.geo = geo; state.selected = null; store.set('geo', geo); }
  FILTERS.zone.set('@near');
  nearMsg = '';
  reopenPop('zone');
}

function closePop() {
  popKey = null;
  $('#pop').hidden = true;
  for (const c of document.querySelectorAll('.chip')) c.classList.remove('open');
}

function bindControls() {
  const seg = (sel, key, attr) =>
    $(sel).addEventListener('click', (e) => {
      const b = e.target.closest(`[data-${attr}]`);
      if (!b) return;
      state[key] = b.dataset[attr];
      if (key === 'version') store.set('version', state.version);
      render();
    });
  seg('#tabs', 'tab', 'tab');
  seg('#view', 'view', 'view');
  seg('#version', 'version', 'v');
  seg('#days', 'date', 'date');

  // Puces de filtre
  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) { e.stopPropagation(); openPop(chip.dataset.f, chip); }
  });
  $('#reset').onclick = () => {
    for (const [k, f] of Object.entries(FILTERS)) {
      if (f.neutral) continue;
      if (f.single) f.set(f.def);
      else { state[k].clear(); f.set?.(); }
    }
    state.version = '';
    store.set('version', '');
    render();
  };
  const pop = $('#pop');
  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.addEventListener('change', (e) => {
    const f = FILTERS[popKey];
    const v = e.target.value;
    if (f.single) {
      f.set(v);
      closePop();
    } else {
      e.target.checked ? state[popKey].add(v) : state[popKey].delete(v);
      // Une même valeur peut apparaître deux fois (favoris + zone) : synchroniser les cases
      for (const i of pop.querySelectorAll(`input[value="${CSS.escape(v)}"]`)) i.checked = e.target.checked;
      f.set?.();
    }
    render();
  });
  pop.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    // Bloc « Autour de… »
    if (a.dataset.action === 'radius') {
      state.radius = Number(a.dataset.r);
      store.set('radius', state.radius);
      if (state.geo) return useNear();
      nearMsg = 'Choisissez d’abord un point : votre position ou une adresse.';
      return reopenPop('zone');
    }
    if (a.dataset.action === 'addr') return useNear(nearResults[a.dataset.i]);
    if (a.dataset.action === 'locate') {
      if (!navigator.geolocation) { nearMsg = 'Géolocalisation indisponible dans ce navigateur.'; return reopenPop('zone'); }
      a.textContent = 'Localisation…';
      navigator.geolocation.getCurrentPosition(
        (pos) => useNear({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Ma position' }),
        () => { nearMsg = 'Position refusée ou introuvable : saisissez plutôt une adresse.'; reopenPop('zone'); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
      return;
    }
    const f = FILTERS[popKey];
    if (a.dataset.action === 'clear') state[popKey].clear();
    if (a.dataset.action === 'favs') for (const id of state.favs) state[popKey].add(id);
    f.set?.();
    const key = popKey, chip = document.querySelector(`.chip[data-f="${key}"]`);
    closePop();
    render();
    openPop(key, chip);
  });
  let addrTimer;
  pop.addEventListener('input', (e) => {
    if (e.target.classList.contains('pop-addr')) {
      clearTimeout(addrTimer);
      const q = e.target.value.trim();
      const list = pop.querySelector('.pop-addr-list');
      if (q.length < 3) { list.hidden = true; return; }
      addrTimer = setTimeout(async () => {
        try { nearResults = await searchAddress(q, state.geo || undefined); } catch { nearResults = []; }
        list.innerHTML = nearResults.map((r, i) => `<li data-action="addr" data-i="${i}">${esc(r.label)}</li>`).join('');
        list.hidden = !nearResults.length;
      }, 250);
      return;
    }
    if (!e.target.classList.contains('pop-search')) return;
    const q = fold(e.target.value.trim());
    for (const o of pop.querySelectorAll('.pop-opt')) o.parentElement.hidden = q && !o.dataset.q.includes(q);
    for (const g of pop.querySelectorAll('.pop-group')) g.hidden = !!q;
  });
  document.addEventListener('click', () => popKey && closePop());
  window.addEventListener('resize', () => popKey && !$('#pop').classList.contains('inline') && closePop());
  // Colonne de filtres sur mobile
  $('#filtersToggle').onclick = () => document.body.classList.toggle('filters-open');
  $('#sideClose').onclick = () => document.body.classList.remove('filters-open');

  let t;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 120);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popKey) return closePop();
    if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape' && document.activeElement === $('#q')) { $('#q').value = ''; state.q = ''; render(); $('#q').blur(); }
  });

  $('#list').addEventListener('click', (e) => {
    const fav = e.target.closest('.fav');
    if (fav) {
      e.stopPropagation();
      const id = fav.dataset.id;
      state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id);
      store.set('favs', [...state.favs]);
      render();
      return;
    }
    if (e.target.closest('a')) return;
    const row = e.target.closest('.row');
    if (!row) return;
    const li = row.parentElement;
    const key = li.dataset.key;
    state.open.has(key) ? state.open.delete(key) : state.open.add(key);
    li.classList.toggle('open');
    if (li.classList.contains('open') && !li.querySelector('.detail').childElementCount) fillDetail(li);
    if (state.view === 'map' && key.startsWith('t') && li.classList.contains('open')) cineMap?.focus(key.slice(1));
  });


  bindPrefs();
  $('#printBtn').onclick = printProgramme;
  window.addEventListener('hashchange', () => { readHash(); render(); });
}

function applyTheme(pref) {
  const dark = pref ? pref === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// État partageable dans l'URL : #d=week&tab=new&view=cinemas&q=…&g=Drame,Comédie
const LIST_PARAMS = { g: 'genres', l: 'langs', f: 'formats' };
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('d') && (P.dates.includes(h.get('d')) || h.get('d') === 'week')) state.date = h.get('d');
  for (const k of ['tab', 'view', 'q', 'sort', 'hours']) if (h.has(k)) state[k] = h.get(k);
  if (!['films', 'map'].includes(state.view)) state.view = 'films';
  for (const [p, k] of Object.entries(LIST_PARAMS)) if (h.has(p)) state[k] = new Set(h.get(p).split(',').filter(Boolean));
  if (h.has('q')) $('#q').value = state.q;
}
function writeHash() {
  const h = new URLSearchParams();
  if (state.date !== P.dates[0]) h.set('d', state.date);
  if (state.tab !== 'all') h.set('tab', state.tab);
  if (state.view !== 'films') h.set('view', state.view);
  if (state.sort !== 'copies') h.set('sort', state.sort);
  if (state.hours !== '0') h.set('hours', state.hours);
  for (const [p, k] of Object.entries(LIST_PARAMS)) if (state[k].size) h.set(p, [...state[k]].join(','));
  if (state.q) h.set('q', state.q);
  const s = h.toString();
  history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
}

// ------------------------------------------------------------------ Filtrage

function inZone(t) {
  const z = state.zone;
  if (z === '@near') {
    if (!hasCoords(t)) return false;
    return !state.geo || dist(t) <= state.radius;
  }
  if (!z) return true;
  if (z === '@paris') return t.area.startsWith('Paris ');
  if (z === '@banlieue') return t.dept !== '75';
  if (/^@9\d$/.test(z)) return t.dept === z.slice(1);
  return t.area === z;
}

const refDate = () => (state.date === 'week' ? parisNow().date : state.date);
function ageDays(m) {
  const ref = new Date(refDate());
  if (!m.release) return m.year ? (ref.getFullYear() - m.year) * 365 : Infinity;
  return (ref - new Date(m.release)) / 864e5;
}
const isNew = (m) => ageDays(m) < 35; // sorties des 5 dernières semaines et avant-premières
const isClassic = (m) => ageDays(m) > 730 || (m.year && new Date(refDate()).getFullYear() - m.year >= 3);

function hourOk(time) {
  switch (state.hours) {
    case '0': case 'now': return true;
    case 'm': return time < '12:00';
    case 'a': return time >= '12:00' && time < '18:00';
    default: return time >= state.hours.padStart(2, '0') + ':00';
  }
}

function filteredShows() {
  const now = parisNow();
  const nowStamp = `${now.date}T${now.time}`;
  hiddenSeen = new Set();
  const q = fold(state.q);
  const tabOk = { all: () => true, new: isNew, classic: isClassic, retro: isClassic }[state.tab] || (() => true);
  const cards = CARDS.filter((c) => state.cards.has(c.id));

  return P.showtimes.filter((s) => {
    if (state.date !== 'week' && !s[2].startsWith(state.date)) return false;
    if (s[2] < nowStamp) return false; // séances passées
    if (!hourOk(s[2].slice(11))) return false;
    if (state.version && s[3] !== state.version) return false;
    if (state.formats.size && !formatsOf(s).some((f) => state.formats.has(f))) return false;
    const t = P.theaters[s[1]];
    if (!t || isHiddenTheater(t) || !inZone(t)) return false;
    if (state.cinemas.size && !state.cinemas.has(t.id)) return false;
    if (cards.length && !cards.some((c) => acceptsCard(c, t, P.cards))) return false;
    const m = P.movies[s[0]];
    if (!tabOk(m)) return false;
    if (state.langs.size && !state.langs.has(m.lang)) return false;
    if (state.genres.size && !m.genres.some((g) => state.genres.has(g))) return false;
    if (q && !m._q.includes(q) && !t._q.includes(q)) return false;
    if (isHiddenMovie(m)) { hiddenSeen.add(m.id); return false; } // en dernier : compte les films réellement masqués
    return true;
  });
}

const isHiddenTheater = (t) => state.hiddenChains.size > 0 && state.hiddenChains.has(t.chain);
const isHiddenMovie = (m) => state.hiddenPeople.size > 0 && [...m.directors, ...m.cast].some((p) => state.hiddenPeople.has(p));
let hiddenSeen = new Set(); // films masqués par les préférences dans la sélection courante

// ------------------------------------------------------------------ Rendu

let current = { shows: [], byKey: new Map() };

function render() {
  // états visuels des contrôles
  for (const b of $('#tabs').querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === state.tab);
  for (const b of $('#view').children) b.classList.toggle('on', b.dataset.view === state.view);
  for (const b of $('#version').children) b.classList.toggle('on', b.dataset.v === state.version);
  for (const b of $('#days').children) b.classList.toggle('on', b.dataset.date === state.date);
  for (const c of document.querySelectorAll('.chip')) {
    c.textContent = chipText(c.dataset.f);
    c.classList.toggle('active', isActive(c.dataset.f));
  }
  if (state.sort !== 'copies' && RATINGS.some((r) => r.key === state.sort) && !state.showRatings.has(state.sort)) state.sort = 'copies';
  const isMap = state.view === 'map';
  $('#reset').hidden = !Object.keys(FILTERS).some(isActive) && !state.version;
  $('#mapBox').hidden = !isMap;
  document.querySelector('.chip[data-f="sort"]').hidden = isMap; // le tri concerne la liste des films
  $('#results').classList.toggle('map-mode', isMap);
  document.documentElement.style.setProperty('--ncells', visibleRatings().length);
  setStatus(isMap && state.zone !== '@near' ? 'Astuce : cliquez sur la carte (ou utilisez « Lieu → Autour de… ») pour chercher autour d’un point.' : '');
  $('#days .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  writeHash();

  const shows = filteredShows();
  current = { shows, byKey: new Map() };
  const films = state.view === 'films';
  const items = films ? groupByMovie(shows) : groupByTheater(shows);

  $('#empty').hidden = shows.length > 0;
  const nF = new Set(shows.map((s) => s[0])).size, nC = new Set(shows.map((s) => s[1])).size;
  $('#resultsCount').textContent = shows.length ? `${nF} film${nF > 1 ? 's' : ''} · ${shows.length} séance${shows.length > 1 ? 's' : ''} · ${nC} cinéma${nC > 1 ? 's' : ''}` : '';

  // En-tête des colonnes (vue Films)
  $('#listHead').hidden = !films || !shows.length;
  $('#listHead').innerHTML = films
    ? `<span></span><span>Film</span><span>Réalisation</span><span class="cells">${visibleRatings().map((r) => `<button class="cell${state.sort === r.key ? ' on' : ''}" data-sort="${r.key}" title="Trier par ${esc(r.title)}">${esc(r.short || r.label)}</button>`).join('')}</span>`
    : '';
  $('#listHead').onclick = (e) => {
    const b = e.target.closest('[data-sort]');
    if (b) { state.sort = state.sort === b.dataset.sort ? 'copies' : b.dataset.sort; render(); }
  };

  const html = [];
  for (const it of items) {
    if (it.group) { html.push(`<li class="group-title">${esc(it.group)}</li>`); continue; }
    current.byKey.set(it.key, it);
    html.push(it.html);
  }
  $('#list').innerHTML = html.join('');
  // Un seul résultat de recherche → on l'ouvre directement
  const only = $('#list').querySelectorAll('.item');
  if (state.q && only.length === 1) only[0].classList.add('open');
  for (const li of $('#list').querySelectorAll('.item.open')) fillDetail(li);

  if (isMap) updateMap(shows);
}

function groupByMovie(shows) {
  const map = new Map();
  for (const s of shows) {
    if (!map.has(s[0])) map.set(s[0], { shows: [], theaters: new Set() });
    const g = map.get(s[0]);
    g.shows.push(s);
    g.theaters.add(s[1]);
  }
  const list = [...map.entries()].map(([id, g]) => ({ m: P.movies[id], ...g }));
  const byRating = (k) => (a, b) => (b.m[k] ?? -1) - (a.m[k] ?? -1);
  const by = {
    copies: (a, b) => b.theaters.size - a.theaters.size || b.shows.length - a.shows.length,
    release: (a, b) => String(b.m.release ?? '').localeCompare(String(a.m.release ?? '')),
    year: (a, b) => (b.m.year || 0) - (a.m.year || 0),
    title: (a, b) => a.m.title.localeCompare(b.m.title, 'fr'),
    ...Object.fromEntries(RATINGS.map((r) => [r.key, byRating(r.key)])),
  }[state.sort] || ((a, b) => b.theaters.size - a.theaters.size);
  list.sort(by);

  const card = (x) => {
    const key = 'm' + x.m.id;
    return { key, m: x.m, shows: x.shows, theaters: x.theaters, html: movieRow(key, x.m) };
  };

  if (state.tab !== 'retro') return list.map(card);

  // Rétrospectives : réalisateurs ayant au moins 2 classiques à l'affiche
  const byDir = new Map();
  for (const x of list) for (const d of x.m.directors) (byDir.get(d) || byDir.set(d, []).get(d)).push(x);
  const out = [];
  [...byDir.entries()]
    .filter(([, xs]) => xs.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'fr'))
    .forEach(([d, xs]) => {
      out.push({ group: `${d} — ${xs.length} films` });
      xs.sort((a, b) => (a.m.year || 0) - (b.m.year || 0)).forEach((x) => out.push(card(x)));
    });
  return out;
}

function groupByTheater(shows) {
  const map = new Map();
  for (const s of shows) (map.get(s[1]) || map.set(s[1], []).get(s[1])).push(s);
  const list = [...map.entries()].map(([id, ss]) => ({ t: P.theaters[id], shows: ss }));
  if (state.view === 'map' && state.zone === '@near' && state.geo) {
    list.sort((a, b) => dist(a.t) - dist(b.t));
    return list.map((x) => ({ key: 't' + x.t.id, t: x.t, shows: x.shows, html: theaterRow('t' + x.t.id, x.t, x.shows) }));
  }
  list.sort((a, b) => state.favs.has(b.t.id) - state.favs.has(a.t.id) || byPlace(a.t, b.t));

  const out = [];
  let lastGroup = null;
  for (const x of list) {
    const g = state.favs.has(x.t.id) ? '★ Mes cinémas' : x.t.area;
    if (g !== lastGroup) out.push({ group: (lastGroup = g) });
    const key = 't' + x.t.id;
    out.push({ key, t: x.t, shows: x.shows, html: theaterRow(key, x.t, x.shows) });
  }
  return out;
}
const areaRank = (a) => (a.startsWith('Paris ') ? parseInt(a.slice(6)) : 100);
// Ordre des cinémas : arrondissements, puis département, ville et nom
const byPlace = (a, b) =>
  areaRank(a.area) - areaRank(b.area) || String(a.dept).localeCompare(String(b.dept)) || a.area.localeCompare(b.area, 'fr') || a.name.localeCompare(b.name, 'fr');

function ratingCells(m) {
  return `<span class="cells">${visibleRatings().map((r) => {
    const v = m[r.key];
    if (v == null) return `<span class="cell na" title="${esc(r.title)}">–</span>`;
    return `<span class="cell${v >= r.hi ? ' hi' : ''}" title="${esc(r.title)}"><i>${esc(r.short || r.label)}</i>${esc(r.fmt(v))}</span>`;
  }).join('')}</span>`;
}

function movieRow(key, m) {
  const open = state.open.has(key) ? ' open' : '';
  const orig = m.originalTitle ? `<small>${esc(m.originalTitle)}</small>` : '';
  return `<li class="item${open}" data-key="${key}">
    <div class="row" role="button" tabindex="0">
      <span class="poster" style="background-image:url('${POSTER(m.poster)}')"></span>
      <span class="title">${esc(m.title)}${orig}</span>
      <span class="who"><span>${esc(m.directors.slice(0, 2).join(', ') || '—')}</span><span class="year">${esc(m.year || '')}</span></span>
      ${ratingCells(m)}
    </div>
    <div class="detail"></div>
  </li>`;
}

function theaterRow(key, t, shows) {
  const open = state.open.has(key) ? ' open' : '';
  const nFilms = new Set(shows.map((s) => s[0])).size;
  const initials = t.name.replace(/^(le|la|les|l')\s*/i, '').slice(0, 2).toUpperCase();
  const fav = state.favs.has(t.id);
  const sel = state.selected === t.id ? ' sel' : '';
  return `<li class="item cine-item${open}${sel}" data-key="${key}" id="${key}">
    <div class="row" role="button" tabindex="0">
      <span class="poster cine">${esc(initials)}</span>
      <span class="title">${esc(t.name)}</span>
      <span class="who"><span>${dist(t) != null ? `<b class="dist">${fmtDistance(dist(t))}</b> · ` : ''}${esc(t.address)}</span><span class="year">${nFilms} film${nFilms > 1 ? 's' : ''}</span></span>
      <span class="side"><button class="fav ${fav ? 'on' : ''}" data-id="${t.id}" title="${fav ? 'Retirer de' : 'Ajouter à'} mes cinémas">${fav ? '★' : '☆'}</button></span>
    </div>
    <div class="detail"></div>
  </li>`;
}

function chip(s, tid) {
  const tag = [s[3], ...formatsOf(s).map((f) => FORMAT_LABEL[f] || f)].join(' ');
  return `<a class="time" href="${CINE_URL(tid)}" target="_blank" rel="noopener" title="${esc(tag)}">${s[2].slice(11)}<i class="${s[3] === 'VO' ? 'vo' : ''}">${esc(tag)}</i></a>`;
}

// Horaires ; en mode semaine, regroupés par jour
function timeChips(shows, tid) {
  if (state.date !== 'week') return `<div class="times">${shows.map((s) => chip(s, tid)).join('')}</div>`;
  const byDay = new Map();
  for (const s of shows) (byDay.get(s[2].slice(0, 10)) || byDay.set(s[2].slice(0, 10), []).get(s[2].slice(0, 10))).push(s);
  return `<div class="days-times">${[...byDay]
    .map(([d, ss]) => `<div class="day-line"><span class="day-name">${esc(dayLabel(d))}</span><div class="times">${ss.map((s) => chip(s, tid)).join('')}</div></div>`)
    .join('')}</div>`;
}

function fillDetail(li) {
  const it = current.byKey.get(li.dataset.key);
  if (!it) return;
  const box = li.querySelector('.detail');

  if (it.m) {
    const m = it.m;
    const byT = new Map();
    for (const s of it.shows) (byT.get(s[1]) || byT.set(s[1], []).get(s[1])).push(s);
    const places = [...byT.entries()]
      .map(([tid, ss]) => ({ t: P.theaters[tid], ss }))
      .sort((a, b) =>
        state.favs.has(b.t.id) - state.favs.has(a.t.id) ||
        (state.geo ? (dist(a.t) ?? 1e9) - (dist(b.t) ?? 1e9) : 0) ||
        byPlace(a.t, b.t)
      );
    const facts = [
      m.runtime,
      m.genres.join(', '),
      m.countries.join(', '),
      m.lang && langLabel(m.lang),
      m.release ? `sortie le ${new Date(m.release).toLocaleDateString('fr-FR', { dateStyle: 'long' })}` : '',
    ].filter(Boolean).map(esc);
    const links = [
      `<a href="${FILM_URL(m.allocineId)}" target="_blank" rel="noopener">Allociné</a>`,
      ...visibleRatings().filter((r) => !['press', 'spect'].includes(r.key) && r.url(m)).map((r) => `<a href="${esc(r.url(m))}" target="_blank" rel="noopener">${esc(r.label)}</a>`),
    ];
    const nT = byT.size, nS = it.shows.length;
    box.innerHTML =
      `<div class="film-head"><div class="film-main">` +
      (m.cast.length ? `<p class="credits">Avec ${m.cast.map(esc).join(', ')}</p>` : '') +
      (m.synopsis ? `<p class="synopsis">${esc(m.synopsis)}</p>` : '') +
      `</div><aside class="film-side">` +
      (facts.length ? `<ul class="facts">${facts.map((f) => `<li>${f}</li>`).join('')}</ul>` : '') +
      `<ul class="credits links">${links.map((l) => `<li>${l}</li>`).join('')}</ul>` +
      `<p class="credits links count">${nS} séance${nS > 1 ? 's' : ''} · ${nT} cinéma${nT > 1 ? 's' : ''}</p>` +
      `</aside></div>` +
      places
        .map(({ t, ss }) => `<div class="place"><div class="place-name">${state.favs.has(t.id) ? '★ ' : ''}${esc(t.name)}<small>${esc(t.area)}${dist(t) != null ? ` · ${fmtDistance(dist(t))}` : ''}</small></div>${timeChips(ss, t.id)}</div>`)
        .join('');
  } else {
    const t = it.t;
    const byM = new Map();
    for (const s of it.shows) (byM.get(s[0]) || byM.set(s[0], []).get(s[0])).push(s);
    const films = [...byM.entries()].map(([mid, ss]) => ({ m: P.movies[mid], ss })).sort((a, b) => a.ss[0][2].localeCompare(b.ss[0][2]));
    box.innerHTML =
      `<p class="credits"><a href="${CINE_URL(t.id)}" target="_blank" rel="noopener">Page du cinéma ↗</a>${t.screens ? ` · ${t.screens} salle${t.screens > 1 ? 's' : ''}` : ''}</p>` +
      films
        .map(({ m, ss }) => `<div class="place"><div class="place-name">${esc(m.title)}<small>${esc([m.directors[0], m.year].filter(Boolean).join(' · '))}</small></div>${timeChips(ss, t.id)}</div>`)
        .join('');
  }
}

// ------------------------------------------------------------------ Export PDF

// Tableau imprimable du programme filtré : film · cinéma · horaires (sans les notes)
function printProgramme() {
  if (!current?.shows.length) return alert('Aucune séance à exporter avec ces filtres.');
  const week = state.date === 'week';
  const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const when = week ? `du ${fmtDay(P.dates[0])} au ${fmtDay(P.dates.at(-1))}` : fmtDay(state.date);
  const time = (s) => `<span class="pt">${s[2].slice(11)}${s[3] ? `<i>${esc([s[3], ...formatsOf(s).map((f) => FORMAT_LABEL[f] || f)].join(' '))}</i>` : ''}</span>`;
  const times = (ss) => {
    if (!week) return ss.map(time).join(' ');
    const byDay = new Map();
    for (const s of ss) (byDay.get(s[2].slice(0, 10)) || byDay.set(s[2].slice(0, 10), []).get(s[2].slice(0, 10))).push(s);
    return [...byDay].map(([d, x]) => `<div><b>${esc(dayLabel(d))}</b> ${x.map(time).join(' ')}</div>`).join('');
  };

  // Blocs : titres de groupe (rétrospectives) et films avec leurs cinémas
  const blocks = [];
  for (const it of groupByMovie(current.shows)) {
    if (it.group) { blocks.push({ group: `<tr class="pg"><th colspan="3">${esc(it.group)}</th></tr>` }); continue; }
    const m = it.m;
    const byT = new Map();
    for (const s of it.shows) (byT.get(s[1]) || byT.set(s[1], []).get(s[1])).push(s);
    const places = [...byT].map(([tid, ss]) => ({ t: P.theaters[tid], ss })).sort((a, b) => byPlace(a.t, b.t));
    const info = [m.directors.join(', '), m.year, m.runtime, m.cast.length && `Avec ${m.cast.slice(0, 3).join(', ')}`].filter(Boolean).map((x) => `<small>${esc(x)}</small>`).join('');
    blocks.push({
      head: `<b>${esc(m.title)}</b>${info}`,
      cont: `<b>${esc(m.title)}</b><small>(suite)</small>`,
      rows: places.map(({ t, ss }) => `<td class="pcine">${esc(t.name)}<small>${esc(t.area)}</small></td><td class="ptimes">${times(ss)}</td>`),
    });
  }

  // Mesure hors écran, à la largeur d'une page A4, pour paginer nous-mêmes :
  // un film coupé par un saut de page voit son titre répété en haut de la suivante.
  const out = $('#printout');
  out.classList.add('measuring');
  out.innerHTML = `<table>${blocks.map((b) => b.group || [
    `<tr><td class="pfilm">${b.head}</td><td></td><td></td></tr>`,
    `<tr><td class="pfilm">${b.cont}</td><td></td><td></td></tr>`,
    ...b.rows.map((r) => `<tr><td class="pfilm"></td>${r}</tr>`),
  ].join('')).join('')}</table>`;
  const hs = [...out.querySelectorAll('tr')].map((tr) => tr.getBoundingClientRect().height);
  const mm = 96 / 25.4;
  const pageH = 273 * mm * 0.95; // A4 moins les marges ; réserve car le rendu imprimé est un peu plus haut qu'à l'écran
  const gap = 14; // espace avant chaque film (sauf en haut de page)
  let k = 0;
  for (const b of blocks) {
    if (b.group) { b.h = hs[k++]; continue; }
    b.headH = hs[k++]; b.contH = hs[k++];
    b.rowH = b.rows.map(() => hs[k++]);
  }

  const pages = [[]];
  let used = 0;
  const newPage = () => { pages.push([]); used = 0; };
  const segment = (b, from, to, cont) => {
    const n = to - from;
    return b.rows.slice(from, to).map((r, i) =>
      `<tr class="${i === 0 ? (cont ? 'pc' : 'pf') : ''}">` +
      (i === 0 ? `<td class="pfilm" rowspan="${n}">${cont ? b.cont : b.head}</td>` : '') + r + '</tr>'
    ).join('');
  };
  blocks.forEach((b, bi) => {
    if (b.group) {
      // un titre de groupe ne reste pas seul en bas de page
      const next = blocks[bi + 1];
      const need = b.h + (next && !next.group ? Math.max(next.headH, next.rowH[0]) : 0);
      if (used && used + need > pageH) newPage();
      pages.at(-1).push(b.group); used += b.h;
      return;
    }
    let from = 0, cont = false;
    if (used && used + gap + Math.max(b.headH, b.rowH[0]) <= pageH) { pages.at(-1).push('<tr class="psp"><td colspan="3"></td></tr>'); used += gap; }
    while (from < b.rows.length) {
      const headH = cont ? b.contH : b.headH;
      let to = from, sum = 0;
      while (to < b.rows.length && used + Math.max(headH, sum + b.rowH[to]) <= pageH) sum += b.rowH[to++];
      if (to === from) {
        if (used === 0) sum = b.rowH[to++]; // ligne plus haute qu'une page : on la place quand même
        else { newPage(); cont = from > 0; continue; }
      }
      pages.at(-1).push(segment(b, from, to, cont));
      used += Math.max(headH, sum);
      from = to;
      if (from < b.rows.length) { newPage(); cont = true; }
    }
  });

  out.classList.remove('measuring');
  out.innerHTML =
    `<div class="pmargin">Paris Ciné — ${esc(when)}</div>` +
    pages.filter((p) => p.length).map((p) => `<table class="ppage"><tbody>${p.join('')}</tbody></table>`).join('');
  const title = document.title;
  document.title = `Paris Ciné — programme ${week ? 'semaine' : state.date}`;
  window.addEventListener('afterprint', () => { document.title = title; }, { once: true });
  window.print();
}

// ------------------------------------------------------------------ Position & carte

function setStatus(msg, error = false) {
  const el = $('#geoStatus');
  el.hidden = !msg;
  el.textContent = msg;
  el.classList.toggle('error', error);
}

function setGeo(geo) {
  state.geo = geo;
  state.selected = null;
  store.set('geo', geo);
  if (geo) FILTERS.zone.set('@near');
  render();
}

async function updateMap(shows) {
  cineMap ??= new CineMap($('#map'), {
    onPick: (geo) => setGeo(geo),
    onSelect: (id) => selectTheater(id),
  });
  const films = new Map();
  for (const s of shows) (films.get(s[1]) || films.set(s[1], new Set()).get(s[1])).add(s[0]);
  const near = state.zone === '@near' && state.geo;
  const points = Object.values(P.theaters)
    .filter((t) => hasCoords(t) && !isHiddenTheater(t))
    .map((t) => ({ id: t.id, name: t.name, lat: t.lat, lon: t.lon, count: films.get(t.id)?.size || 0, inside: films.has(t.id) || (near && dist(t) <= state.radius) }));
  try {
    await cineMap.update({ points, geo: near ? state.geo : null, radius: state.radius, selected: state.selected });
  } catch {
    setStatus('Impossible de charger la carte (connexion ?).', true);
  }
}

function selectTheater(id) {
  state.selected = id;
  const key = 't' + id;
  state.open.add(key);
  render();
  const li = document.getElementById(key);
  if (li) li.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else setStatus(`${P.theaters[id].name} : aucune séance avec ces filtres.`);
}

// ------------------------------------------------------------------ Préférences

const PREFS_APP = 'paris-cine';
const CODE_PREFIX = 'PC1:';

function openPrefs() {
  closePop();
  renderPrefs();
  $('#prefs').hidden = $('#prefsOverlay').hidden = false;
  document.body.classList.add('no-scroll');
  $('#prefsClose').focus();
}
function closePrefs() {
  $('#prefs').hidden = $('#prefsOverlay').hidden = true;
  document.body.classList.remove('no-scroll');
}

// Tous les noms (réalisateurs et acteurs) du programme, les plus fréquents d'abord
let PEOPLE = null;
function people() {
  if (PEOPLE) return PEOPLE;
  const map = new Map();
  for (const m of Object.values(P.movies)) {
    for (const d of m.directors) { const e = map.get(d) || map.set(d, { name: d, n: 0, dir: false }).get(d); e.n++; e.dir = true; }
    for (const a of m.cast) { const e = map.get(a) || map.set(a, { name: a, n: 0, dir: false }).get(a); e.n++; }
  }
  return (PEOPLE = [...map.values()].map((e) => ({ ...e, q: fold(e.name) })).sort((a, b) => b.n - a.n));
}

function renderPrefs() {
  const pref = store.get('theme', null) || '';
  for (const b of $('#themeSeg').children) b.classList.toggle('on', b.dataset.theme === pref);

  const names = [...state.hiddenPeople].sort((a, b) => a.localeCompare(b, 'fr'));
  $('#hiddenPeople').innerHTML = names.map((n) => `<li><span>${esc(n)}</span><button data-unhide="${esc(n)}" aria-label="Ne plus masquer ${esc(n)}">✕</button></li>`).join('');
  const films = Object.values(P.movies).filter(isHiddenMovie).length;
  $('#peopleHint').textContent = names.length ? `${films} film${films > 1 ? 's' : ''} du programme masqué${films > 1 ? 's' : ''}.` : 'Aucun nom masqué.';

  $('#ratingList').innerHTML = RATINGS.map(
    (r) => `<label class="pop-opt"><input type="checkbox" value="${r.key}" ${state.showRatings.has(r.key) ? 'checked' : ''} /><span>${esc(r.title.replace(/^Note /, ''))}</span></label>`
  ).join('');
  const count = (id) => Object.values(P.theaters).filter((t) => t.chain === id).length;
  $('#chainList').innerHTML = CHAINS.map(
    (c) => `<label class="pop-opt"><input type="checkbox" value="${c.id}" ${state.hiddenChains.has(c.id) ? 'checked' : ''} /><span>${esc(c.label)}</span><small>${count(c.id)} salles</small></label>`
  ).join('');
}

function savePrefsAndRender() {
  store.set('hiddenPeople', [...state.hiddenPeople]);
  store.set('hiddenChains', [...state.hiddenChains]);
  renderPrefs();
  render();
}

function exportPrefs() {
  const prefs = {};
  for (const k of Object.keys(localStorage)) if (k.startsWith('pc.')) prefs[k.slice(3)] = JSON.parse(localStorage.getItem(k));
  return { app: PREFS_APP, version: 1, exportedAt: new Date().toISOString(), prefs };
}
const toCode = (obj) => CODE_PREFIX + btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))));
const fromCode = (code) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(code.trim().slice(CODE_PREFIX.length)), (c) => c.charCodeAt(0))));

function importPrefs(data) {
  if (data?.app !== PREFS_APP || typeof data.prefs !== 'object') throw new Error('Ce fichier ne contient pas de préférences Paris Ciné.');
  Object.keys(localStorage).filter((k) => k.startsWith('pc.')).forEach((k) => localStorage.removeItem(k));
  for (const [k, v] of Object.entries(data.prefs)) localStorage.setItem('pc.' + k, JSON.stringify(v));
  location.reload();
}

function bindPrefs() {
  $('#prefsBtn').onclick = openPrefs;
  $('#prefsClose').onclick = closePrefs;
  $('#prefsOverlay').onclick = closePrefs;
  document.addEventListener('click', (e) => { if (e.target.closest('[data-open-prefs]')) openPrefs(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#prefs').hidden) closePrefs(); });

  $('#themeSeg').onclick = (e) => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    store.set('theme', b.dataset.theme || null);
    applyTheme(b.dataset.theme || null);
    renderPrefs();
    if (state.view === 'map') render();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get('theme', null)));

  // Personnes masquées : autocomplétion
  const input = $('#personInput'), list = $('#personList');
  let results = [], active = -1;
  const show = () => {
    list.innerHTML = results.map((p, i) => `<li data-i="${i}" class="${i === active ? 'on' : ''}">${esc(p.name)} <small>${p.dir ? 'réal.' : 'acteur·rice'} · ${p.n} film${p.n > 1 ? 's' : ''}</small></li>`).join('');
    list.hidden = !results.length;
  };
  const add = (name) => {
    state.hiddenPeople.add(name);
    input.value = '';
    results = [];
    show();
    savePrefsAndRender();
    input.focus();
  };
  input.addEventListener('input', () => {
    const q = fold(input.value.trim());
    results = q.length < 2 ? [] : people().filter((p) => p.q.includes(q) && !state.hiddenPeople.has(p.name)).slice(0, 8);
    active = -1;
    show();
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      show();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(results[Math.max(active, 0)].name);
    } else if (e.key === 'Escape') { e.stopPropagation(); results = []; show(); }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); add(results[li.dataset.i].name); }
  });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 100));
  $('#hiddenPeople').onclick = (e) => {
    const b = e.target.closest('[data-unhide]');
    if (b) { state.hiddenPeople.delete(b.dataset.unhide); savePrefsAndRender(); }
  };

  // Notes affichées
  $('#ratingList').onchange = (e) => {
    e.target.checked ? state.showRatings.add(e.target.value) : state.showRatings.delete(e.target.value);
    store.set('ratings', RATINGS.map((r) => r.key).filter((k) => state.showRatings.has(k)));
    renderPrefs();
    render();
  };

  // Enseignes masquées
  $('#chainList').onchange = (e) => {
    e.target.checked ? state.hiddenChains.add(e.target.value) : state.hiddenChains.delete(e.target.value);
    savePrefsAndRender();
  };

  // Export / import
  const status = (msg) => ($('#ioStatus').textContent = msg);
  $('#exportFile').onclick = () => {
    const blob = new Blob([JSON.stringify(exportPrefs(), null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `paris-cine-preferences-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
    status('Fichier téléchargé. Importez-le dans l’autre navigateur.');
  };
  $('#copyCode').onclick = async () => {
    const code = toCode(exportPrefs());
    try {
      await navigator.clipboard.writeText(code);
      status('Code copié. Collez-le dans l’autre navigateur, puis « Importer le code ».');
    } catch {
      $('#importCode').value = code;
      $('#importCode').select();
      status('Copiez le code sélectionné ci-dessus.');
    }
  };
  $('#importFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { importPrefs(JSON.parse(await file.text())); } catch (err) { status(err.message.startsWith('Ce fichier') ? err.message : 'Fichier illisible.'); }
  };
  $('#importCodeBtn').onclick = () => {
    const code = $('#importCode').value.trim();
    if (!code.startsWith(CODE_PREFIX)) return status('Ce code n’est pas un code de préférences Paris Ciné.');
    try { importPrefs(fromCode(code)); } catch { status('Code invalide ou incomplet.'); }
  };

  $('#forget').onclick = () => {
    if (!confirm('Effacer toutes les préférences enregistrées dans ce navigateur (thème, favoris, masquages, position…) ?')) return;
    Object.keys(localStorage).filter((k) => k.startsWith('pc.')).forEach((k) => localStorage.removeItem(k));
    location.href = location.pathname;
  };
}
