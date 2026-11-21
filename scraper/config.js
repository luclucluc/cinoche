// Zones couvertes. Paris = id Allociné 115755 (tous arrondissements).
// Les villes de banlieue sont résolues automatiquement par leur nom via l'API Allociné.
export const PARIS_CITY_ID = 115755;

export const SUBURBS = [
  // [nom, préfixe code postal attendu]
  ['Boulogne-Billancourt', '92'],
  ['Issy-les-Moulineaux', '92'],
  ['Neuilly-sur-Seine', '92'],
  ['Levallois-Perret', '92'],
  ['Puteaux', '92'],
  ['Courbevoie', '92'],
  ['Clichy', '92'],
  ['Montrouge', '92'],
  ['Malakoff', '92'],
  ['Saint-Denis', '93'],
  ['Saint-Ouen-sur-Seine', '93'],
  ['Aubervilliers', '93'],
  ['Pantin', '93'],
  ['Montreuil', '93'],
  ['Bagnolet', '93'],
  ['Vincennes', '94'],
  ['Saint-Mandé', '94'],
  ['Charenton-le-Pont', '94'],
  ['Ivry-sur-Seine', '94'],
  ['Gentilly', '94'],
  ['Joinville-le-Pont', '94'],
];

export const DEFAULT_DAYS = 7;
export const CONCURRENCY = 2;
