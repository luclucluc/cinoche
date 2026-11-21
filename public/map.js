// Vue carte : Leaflet (marqueurs, cercle, interactions) + fond vectoriel OpenFreeMap rendu par MapLibre.
// Tout est chargé à la demande, uniquement quand on ouvre la vue Carte.

const LIBS = {
  css: ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/maplibre-gl@5.24.1/dist/maplibre-gl.css'],
  // L'ordre compte : le plugin attend window.L et window.maplibregl
  js: [
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/maplibre-gl@5.24.1/dist/maplibre-gl.js',
    'https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js',
  ],
};
// OpenFreeMap : tuiles OpenStreetMap gratuites, sans clé, utilisables sur un site public.
const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
export const PARIS = { lat: 48.8566, lon: 2.3522 };

const loadScript = (src) =>
  new Promise((resolve, reject) => {
    const js = document.createElement('script');
    js.src = src;
    js.onload = resolve;
    js.onerror = () => reject(new Error(`Impossible de charger ${src}`));
    document.head.append(js);
  });

let libsReady;
function loadLibs() {
  libsReady ??= (async () => {
    for (const href of LIBS.css) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = href;
      document.head.append(css);
    }
    for (const src of LIBS.js) await loadScript(src);
    return window.L;
  })();
  return libsReady;
}

export function distance(a, b) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function frenchLabels(gl) {
  for (const layer of gl.getStyle().layers) {
    if (layer.type === 'symbol' && layer.layout?.['text-field']) {
      gl.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:fr'], ['get', 'name']]);
    }
  }
}

const isDark = () => document.documentElement.dataset.theme === 'dark';

export const fmtDistance = (m) =>
  m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 && m % 1000 ? 1 : 0).replace('.', ',')} km`;

export class CineMap {
  constructor(el, { onPick, onSelect }) {
    this.el = el;
    this.onPick = onPick;
    this.onSelect = onSelect;
    this.markers = new Map();
    this.lastView = '';
  }

  async ensure() {
    if (this.map) return;
    const L = (this.L = await loadLibs());
    this.map = L.map(this.el, { zoomControl: false, attributionControl: true }).setView([PARIS.lat, PARIS.lon], 12);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.theme = isDark() ? 'dark' : 'light';
    this.base = L.maplibreGL({ style: STYLES[this.theme], attribution: ATTRIBUTION, interactive: false }).addTo(this.map);
    // Libellés en français (les styles OpenFreeMap affichent l'anglais par défaut)
    this.base.getMaplibreMap().on('style.load', (e) => frenchLabels(e.target));
    this.layer = L.layerGroup().addTo(this.map);
    this.map.on('click', (e) => this.onPick({ lat: e.latlng.lat, lon: e.latlng.lng, label: 'Point choisi sur la carte' }));
  }

  /**
   * @param points [{ id, name, lat, lon, count, inside }]
   * @param geo    { lat, lon, label } | null
   */
  async update({ points, geo, radius, selected }) {
    await this.ensure();
    const L = this.L;
    const theme = isDark() ? 'dark' : 'light';
    if (theme !== this.theme) {
      this.theme = theme;
      this.base.getMaplibreMap().setStyle(STYLES[theme]);
    }
    this.map.invalidateSize();
    this.layer.clearLayers();
    this.markers.clear();

    if (geo) {
      L.circle([geo.lat, geo.lon], { radius, className: 'radius', weight: 1.5, fillOpacity: 0.06, interactive: false }).addTo(this.layer);
      const me = L.marker([geo.lat, geo.lon], {
        draggable: true,
        zIndexOffset: 1000,
        icon: L.divIcon({ className: 'pin-me', iconSize: [18, 18] }),
        title: geo.label,
      }).addTo(this.layer);
      me.on('dragend', () => {
        const p = me.getLatLng();
        this.onPick({ lat: p.lat, lon: p.lng, label: 'Point choisi sur la carte' });
      });
    }

    for (const p of points) {
      const cls = ['pin', p.inside ? '' : 'out', p.count ? '' : 'none', p.id === selected ? 'sel' : ''].join(' ');
      const m = L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: cls, html: `<span>${p.count || ''}</span>`, iconSize: null }),
        title: p.name,
        zIndexOffset: p.inside ? 500 : 0,
        riseOnHover: true,
      }).addTo(this.layer);
      m.bindTooltip(p.name, { direction: 'top', offset: [0, -12] });
      m.on('click', () => this.onSelect(p.id));
      this.markers.set(p.id, m);
    }

    // Recadrage seulement quand le point, le rayon ou l'ensemble des cinémas affichés changent :
    // autour du point s'il y en a un, sinon sur les cinémas des résultats filtrés.
    const inside = points.filter((p) => p.inside);
    const key = geo ? `${geo.lat},${geo.lon},${radius}` : 'pts:' + inside.map((p) => p.id).join(',');
    if (key !== this.lastView) {
      this.lastView = key;
      if (geo) this.map.fitBounds(L.latLng(geo.lat, geo.lon).toBounds(radius * 2.6), { animate: false });
      else if (inside.length > 1) this.map.fitBounds(L.latLngBounds(inside.map((p) => [p.lat, p.lon])), { padding: [30, 30], maxZoom: 15, animate: false });
      else if (inside.length === 1) this.map.setView([inside[0].lat, inside[0].lon], 15, { animate: false });
      else this.map.setView([PARIS.lat, PARIS.lon], 12, { animate: false });
    }
  }

  focus(id) {
    const m = this.markers.get(id);
    if (m) this.map.panTo(m.getLatLng());
  }
}

// ------------------------------------------------------------------ Adresses (Base Adresse Nationale)

export async function searchAddress(q, near = PARIS) {
  const url = `https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&limit=5&autocomplete=1&lat=${near.lat}&lon=${near.lon}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.features.map((f) => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: f.properties.label }));
}
