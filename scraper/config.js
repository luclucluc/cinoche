// Zones couvertes.
// - Paris : id Allociné 115755 (tous arrondissements).
// - Départements de banlieue : toutes leurs communes (liste officielle geo.api.gouv.fr),
//   résolues automatiquement sur Allociné. Les communes sans cinéma sont simplement ignorées.
// - Villes supplémentaires hors de ces départements : EXTRA_CITIES ([nom, code postal]).
export const PARIS_CITY_ID = 115755;

export const DEPARTMENTS = ['92', '93', '94'];

export const EXTRA_CITIES = [
  // ['Versailles', '78000'],
];

export const DEFAULT_DAYS = 7;
export const CONCURRENCY = 2;

// La correspondance commune → ville Allociné est gardée en cache ; la liste des cinémas
// de chaque ville est rafraîchie au bout de THEATERS_TTL_DAYS jours.
export const THEATERS_TTL_DAYS = 7;
