// Cartes illimitées / abonnements, et cinémas qui les acceptent.
// Allociné ne fournit pas cette information : les règles se basent sur le nom de l'enseigne.
// Pour ajouter une salle partenaire, ajoutez son identifiant Allociné (ex. 'C0159') à `extra`.
// À compléter : Carte CIP (Cinémas Indépendants Parisiens) et Cinéchèques, qui nécessitent
// la liste exacte des salles adhérentes.

export const CARDS = [
  { id: 'ugc', label: 'UGC Illimité', match: /^(UGC|MK2)\b/i, extra: [] }, // UGC + MK2 (accord de réciprocité)
  { id: 'pathe', label: 'CinéPass Pathé (ex-Le Pass Gaumont)', match: /^(Path[ée]|Gaumont)\b/i, extra: [] },
  { id: 'ugc5', label: 'UGC « la carte » 5 places', match: /^UGC\b/i, extra: [] },
  { id: 'mk2', label: 'Carte MK2 5 places', match: /^MK2\b/i, extra: [] },
];

export const acceptsCard = (card, theater) => card.match.test(theater.name) || card.extra.includes(theater.id);
