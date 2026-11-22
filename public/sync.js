// Synchronisation facultative des préférences, par clé (sans e-mail ni mot de passe).
//
// Deux modes, choisis par appareil (clé locale « pcsync.mode », jamais synchronisée) :
//  - « local »   : préférences uniquement dans ce navigateur (par défaut, aucun appel réseau) ;
//  - « account » : les préférences (clés pc.*) sont enregistrées en ligne sous une clé secrète
//                  aléatoire ; on retrouve tout sur un autre appareil avec cette clé (code, lien ou QR).
// La version la plus récente l'emporte ; chaque modification locale est envoyée peu après.

import { SYNC } from './config.js';

const K = { mode: 'pcsync.mode', key: 'pcsync.key', at: 'pcsync.at', dirty: 'pcsync.dirty' };
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans 0/O, 1/I/L : se recopie sans erreur
const KEY_LEN = 26;
const PUSH_DELAY = 2500;

export const syncConfigured = () => !!SYNC.endpoint;
export const syncMode = () => (localStorage.getItem(K.mode) === 'account' ? 'account' : 'local');
const getKey = () => localStorage.getItem(K.key);

let hooks = null; // { collect, apply, onChange }
let pushTimer = null;
let info = { error: null, busy: false };

// ------------------------------------------------------------------ Clés

export function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_LEN));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}
export const formatKey = (k) => (k || '').match(/.{1,4}/g)?.join('-') || '';
export const normalizeKey = (k) => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const isValidKey = (k) => new RegExp(`^[${ALPHABET}]{${KEY_LEN}}$`).test(k);
export const shareLink = () => `${location.origin}${location.pathname}#sync=${getKey()}`;

// ------------------------------------------------------------------ Réseau

async function api(method, body) {
  const res = await fetch(`${SYNC.endpoint}/prefs/${getKey()}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
  return res.status === 204 ? true : res.json();
}

// ------------------------------------------------------------------ État

const changed = () => hooks?.onChange?.(syncState());
export function syncState() {
  return { configured: syncConfigured(), mode: syncMode(), key: getKey(), lastSync: localStorage.getItem(K.at), ...info };
}

/**
 * @param collect   () => préférences (clés sans le préfixe pc.)
 * @param apply     (prefs) => remplace les préférences locales (puis recharge la page)
 * @param onChange  (état) => mise à jour de l'interface
 * @param joinKey   clé reçue par un lien « #sync=… », capturée au démarrage
 */
export async function initSync({ collect, apply, onChange, joinKey }) {
  hooks = { collect, apply, onChange };
  if (!syncConfigured()) return changed();
  if (joinKey) return join(joinKey);
  if (syncMode() === 'account' && getKey()) {
    try { await pull(); } catch (err) { info.error = 'Synchronisation indisponible pour le moment.'; console.warn('sync', err); }
  }
  changed();
}

async function pull({ askOnConflict = false } = {}) {
  const remote = await api('GET');
  if (!remote) return push(); // rien en ligne pour cette clé : on y envoie ce navigateur
  const localAt = localStorage.getItem(K.at);
  const remoteNewer = !localAt || new Date(remote.updated_at) > new Date(localAt);
  if (askOnConflict && localStorage.getItem(K.dirty) && hasRealPrefs(hooks.collect())) {
    const useAccount = confirm(
      'Ce compte contient déjà des préférences.\n\nOK : utiliser celles du compte sur ce navigateur.\nAnnuler : remplacer celles du compte par celles de ce navigateur.'
    );
    if (!useAccount) return push();
  } else if (!remoteNewer) {
    if (localStorage.getItem(K.dirty)) return push();
    return;
  }
  localStorage.setItem(K.at, remote.updated_at);
  localStorage.removeItem(K.dirty);
  hooks.apply(remote.data || {});
}

// Préférences réellement renseignées ? (un appareil neuf n'a que des valeurs vides : pas de question)
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) ? !v.length : typeof v === 'object' && !Object.keys(v).length);
const hasRealPrefs = (prefs) => Object.values(prefs).some((v) => !isEmpty(v));

async function push() {
  if (syncMode() !== 'account' || !getKey()) return;
  try {
    const { updated_at } = await api('PUT', { data: hooks.collect() });
    localStorage.setItem(K.at, updated_at);
    localStorage.removeItem(K.dirty);
    info.error = null;
  } catch (err) {
    info.error = 'Échec de l’envoi des préférences (nouvel essai à la prochaine modification).';
    console.warn('sync', err);
  }
  changed();
}

// À appeler après chaque modification des préférences locales
export function notifyPrefsChanged() {
  localStorage.setItem(K.dirty, '1');
  if (syncMode() !== 'account' || !getKey()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, PUSH_DELAY);
}

// ------------------------------------------------------------------ Actions

export async function setMode(mode) {
  localStorage.setItem(K.mode, mode === 'account' ? 'account' : 'local');
  info.error = null;
  if (mode === 'local') clearTimeout(pushTimer);
  changed();
}

// Créer un compte : nouvelle clé, on y envoie les préférences de ce navigateur
export async function createAccount() {
  localStorage.setItem(K.key, newKey());
  localStorage.setItem(K.mode, 'account');
  localStorage.removeItem(K.at);
  info = { error: null, busy: true };
  changed();
  await push();
  info.busy = false;
  changed();
}

// Rejoindre un compte existant (clé saisie ou lien #sync=…)
export async function join(raw) {
  const key = normalizeKey(raw);
  if (!isValidKey(key)) { info.error = 'Cette clé n’est pas valide.'; return changed(); }
  const previous = getKey();
  localStorage.setItem(K.key, key);
  localStorage.setItem(K.mode, 'account');
  if (previous !== key) localStorage.removeItem(K.at);
  info = { error: null, busy: true };
  changed();
  try {
    const remote = await api('GET');
    if (!remote) {
      localStorage.setItem(K.key, previous || '');
      if (!previous) localStorage.removeItem(K.key);
      info = { error: 'Aucun compte ne correspond à cette clé.', busy: false };
      return changed();
    }
    await pull({ askOnConflict: true });
  } catch (err) {
    info.error = 'Synchronisation indisponible pour le moment.';
    console.warn('sync', err);
  }
  info.busy = false;
  changed();
}

export async function syncNow() {
  info.busy = true;
  changed();
  try { await pull(); await push(); } catch { info.error = 'Synchronisation indisponible pour le moment.'; }
  info.busy = false;
  changed();
}

// Quitter le compte sur ce navigateur (les préférences locales et le compte en ligne restent)
export function leave() {
  localStorage.removeItem(K.key);
  localStorage.removeItem(K.at);
  localStorage.setItem(K.mode, 'local');
  info = { error: null, busy: false };
  changed();
}

// Supprimer le compte en ligne (pour tous les appareils)
export async function deleteAccount() {
  try { await api('DELETE'); } catch { info.error = 'Suppression impossible pour le moment.'; return changed(); }
  leave();
}

// QR code du lien de synchronisation (bibliothèque chargée à la demande)
export async function qrSvg(text) {
  const { default: qrcode } = await import('https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/+esm');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
