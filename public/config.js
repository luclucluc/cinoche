// Synchronisation facultative des préférences entre appareils.
// Service : worker/ (Cloudflare Worker + KV), déployé par .github/workflows/worker.yml.
// Laisser `endpoint` vide désactive la synchronisation (mode « ce navigateur » uniquement).
export const SYNC = {
  endpoint: 'https://paris-cine-sync.cine-infos.workers.dev',
};
