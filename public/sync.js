// Synchronisation facultative des préférences via un compte (Supabase).
//
// Deux modes, choisis par appareil (clé locale « pcsync.mode », jamais synchronisée) :
//  - « local »   : préférences uniquement dans ce navigateur (par défaut, aucun appel réseau) ;
//  - « account » : connexion par lien envoyé par e-mail ; les préférences (clés pc.*) sont
//                  enregistrées dans le compte et suivent sur tous les appareils.
// Règle de synchronisation : la version la plus récente l'emporte ; chaque modification locale
// est envoyée quelques secondes plus tard.

import { SYNC } from './config.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm';
const K = { mode: 'pcsync.mode', at: 'pcsync.at', dirty: 'pcsync.dirty', email: 'pcsync.email' };
const PUSH_DELAY = 1500;

export const syncConfigured = () => !!(SYNC.url && SYNC.anonKey);
export const syncMode = () => (localStorage.getItem(K.mode) === 'account' ? 'account' : 'local');

let client = null;
let user = null;
let hooks = null; // { collect, apply, onChange }
let pushTimer = null;
let info = { linkSentTo: null, error: null, busy: false };

async function sb() {
  if (!client) {
    const { createClient } = await import(LIB);
    client = createClient(SYNC.url, SYNC.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'pcsync.session' },
    });
  }
  return client;
}

const changed = () => hooks?.onChange?.(syncState());
export function syncState() {
  return {
    configured: syncConfigured(),
    mode: syncMode(),
    email: user?.email || null,
    lastSync: localStorage.getItem(K.at),
    ...info,
  };
}

/**
 * @param collect  () => objet des préférences (clés sans le préfixe pc.)
 * @param apply    (prefs) => remplace les préférences locales (puis recharge la page)
 * @param onChange (état) => mise à jour de l'interface
 * @param authReturn  fragment d'URL du lien de connexion (#access_token=…), capturé au démarrage
 */
export async function initSync({ collect, apply, onChange, authReturn }) {
  hooks = { collect, apply, onChange };
  if (!syncConfigured()) return changed();
  if (authReturn) localStorage.setItem(K.mode, 'account'); // retour du lien de connexion
  if (syncMode() !== 'account') return changed();
  try {
    const c = await sb();
    if (authReturn) {
      const p = new URLSearchParams(authReturn.replace(/^#/, ''));
      if (p.get('access_token') && p.get('refresh_token')) {
        await c.auth.setSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token') });
      }
    }
    const { data } = await c.auth.getSession();
    user = data.session?.user || null;
    c.auth.onAuthStateChange((_e, session) => { user = session?.user || null; changed(); });
    if (user) await pull({ firstLogin: !!authReturn });
  } catch (err) {
    info.error = 'Synchronisation indisponible pour le moment.';
    console.warn('sync', err);
  }
  changed();
}

// Récupère les préférences du compte et décide qui l'emporte
async function pull({ firstLogin = false } = {}) {
  const c = await sb();
  const { data, error } = await c.from('preferences').select('data, updated_at').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  const localAt = localStorage.getItem(K.at);
  if (!data) return push(); // compte neuf : on y envoie les préférences de ce navigateur

  const remoteNewer = !localAt || new Date(data.updated_at) > new Date(localAt);
  if (firstLogin && localStorage.getItem(K.dirty) !== null && Object.keys(hooks.collect()).length) {
    // Première connexion sur cet appareil alors qu'il a déjà des préférences : on demande
    const useAccount = confirm(
      'Ce compte contient déjà des préférences.\n\nOK : utiliser celles du compte sur ce navigateur.\nAnnuler : remplacer celles du compte par celles de ce navigateur.'
    );
    if (!useAccount) return push();
  } else if (!remoteNewer) {
    if (localStorage.getItem(K.dirty) === '1') return push();
    return;
  }
  localStorage.setItem(K.at, data.updated_at);
  localStorage.removeItem(K.dirty);
  hooks.apply(data.data || {});
}

async function push() {
  if (!user) return;
  const c = await sb();
  const updated_at = new Date().toISOString();
  const { error } = await c.from('preferences').upsert({ user_id: user.id, data: hooks.collect(), updated_at });
  if (error) { info.error = 'Échec de l’envoi des préférences.'; changed(); return; }
  info.error = null;
  localStorage.setItem(K.at, updated_at);
  localStorage.removeItem(K.dirty);
  changed();
}

// À appeler après chaque modification des préférences locales
export function notifyPrefsChanged() {
  localStorage.setItem(K.dirty, '1');
  if (!user || syncMode() !== 'account') return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, PUSH_DELAY);
}

export async function setMode(mode) {
  if (mode === syncMode()) return;
  if (mode === 'local') {
    if (user) await signOut();
    localStorage.setItem(K.mode, 'local');
  } else {
    localStorage.setItem(K.mode, 'account');
    if (syncConfigured()) {
      const { data } = await (await sb()).auth.getSession();
      user = data.session?.user || null;
      if (user) await pull();
    }
  }
  changed();
}

export async function sendLoginLink(email) {
  info = { ...info, busy: true, error: null };
  changed();
  try {
    const { error } = await (await sb()).auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
    localStorage.setItem(K.email, email);
    info.linkSentTo = email;
  } catch (err) {
    info.error = /rate|limit/i.test(String(err?.message)) ? 'Trop de demandes : réessayez dans une minute.' : 'Envoi du lien impossible. Vérifiez l’adresse e-mail.';
  }
  info.busy = false;
  changed();
}

export async function syncNow() {
  if (!user) return;
  await pull();
  await push();
}

export async function signOut() {
  try { await (await sb()).auth.signOut(); } catch {}
  user = null;
  info.linkSentTo = null;
  changed();
}

export async function deleteAccount() {
  const c = await sb();
  const { error } = await c.rpc('delete_me');
  if (error) { info.error = 'Suppression impossible pour le moment.'; changed(); return false; }
  await signOut();
  localStorage.setItem(K.mode, 'local');
  localStorage.removeItem(K.at);
  changed();
  return true;
}

export const lastEmail = () => localStorage.getItem(K.email) || '';
