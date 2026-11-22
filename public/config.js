// Comptes synchronisés (facultatifs) — projet Supabase.
// Tant que ces deux valeurs sont vides, le site fonctionne uniquement en mode « ce navigateur ».
//
// Où les trouver : Supabase → Project Settings → API (ou « Data API »).
// La clé « anon / publishable » est prévue pour être publique : les données sont protégées
// par les règles d'accès définies dans supabase/schema.sql (chacun ne voit que sa ligne).
export const SYNC = {
  url: '', // ex. 'https://abcdefghijklm.supabase.co'
  anonKey: '', // clé publique « anon » / « publishable »
};
