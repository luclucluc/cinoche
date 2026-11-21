// Enseignes de cinéma (pour pouvoir les masquer dans les préférences).
// Reconnues au nom de la salle, ou par identifiant Allociné quand le nom ne suffit pas.

export const CHAINS = [
  { id: 'ugc', label: 'UGC', match: /^UGC\b/i },
  { id: 'pathe', label: 'Pathé (et ex-Gaumont)', match: /^(Path[ée]|Gaumont)(\s|$)/i },
  { id: 'mk2', label: 'MK2', match: /^MK2\b/i },
  { id: 'cgr', label: 'CGR', match: /^CGR\b/i },
  { id: 'megarama', label: 'Mégarama', match: /^M[ée]garama(\s|$)/i },
  // Dulac Cinémas : Reflet Médicis, Majestic Passy, Majestic Bastille, L'Arlequin, Escurial
  { id: 'dulac', label: 'Dulac Cinémas', ids: ['C0074', 'C0120', 'C0139', 'C0054', 'C0147'] },
];

export const chainOf = (theater) => CHAINS.find((c) => c.match?.test(theater.name) || c.ids?.includes(theater.id))?.id || null;
