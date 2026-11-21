// Cartes illimitées / abonnements, et cinémas qui les acceptent.
// Allociné ne fournit pas cette information : les règles se basent sur le nom de l'enseigne.
// Pour ajouter une salle partenaire, ajoutez son identifiant Allociné (ex. 'C0159') à `extra`.
// Cinéchèques : liste mise à jour chaque nuit depuis cinecheque.fr (champ `cards.cinecheque` du programme).

export const CARDS = [
  { id: 'ugc', label: 'UGC Illimité', match: /^(UGC|MK2)\b/i, extra: [] }, // UGC + MK2 (accord de réciprocité)
  { id: 'pathe', label: 'CinéPass Pathé (ex-Le Pass Gaumont)', match: /^(Path[ée]|Gaumont)\b/i, extra: [] },
  { id: 'ugc5', label: 'UGC « la carte » 5 places', match: /^UGC\b/i, extra: [] },
  { id: 'mk2', label: 'Carte MK2 5 places', match: /^MK2\b/i, extra: [] },
  { id: 'cinecheque', label: 'Cinéchèques', match: null, extra: [], source: 'cinecheque' },
  {
    id: 'cip',
    label: 'Carte CIP (Cinémas Indépendants Parisiens)',
    match: null,
    // Liste des 32 salles adhérentes : https://www.cinemasindependantsparisiens.fr/les-cinemas/ (novembre 2026)
    extra: [
      'W7588', 'C0074', 'C0093', 'C0095', 'W7510', 'C0005', 'G0G46', 'C0013', 'C0083', 'C0041', 'C0009',
      'C0134', 'C0025', 'C0061', 'C0072', 'C0071', 'C0015', 'C0108', 'C0023', 'C0120', 'C0016', 'W7504',
      'C0100', 'C0012', 'C0139', 'W7517', 'C0076', 'C0054', 'C0096', 'C0089', 'C0147', 'C0004',
    ],
  },
];

export const acceptsCard = (card, theater, sources = {}) =>
  !!card.match?.test(theater.name) || card.extra.includes(theater.id) || !!sources[card.source]?.includes(theater.id);
