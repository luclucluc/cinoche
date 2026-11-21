// Cinémas acceptant les Cinéchèques, d'après la carte officielle https://www.cinecheque.fr/liste-des-cinemas/
// La carte charge sa liste en envoyant le formulaire « Ville ou code postal » : un envoi sans ville
// renvoie tous les cinémas de France, chacun avec son lien Allociné (identifiant exact de la salle).
// Deux requêtes au total (la page, puis le formulaire).

const BASE = 'https://www.cinecheque.fr/liste-des-cinemas/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^(le|la|les|l')\s*/, '').replace(/[^a-z0-9]/g, '');

/**
 * @param theaters  cinémas du programme ({ id: { name, dept } })
 * @param depts     départements à garder (ex. ['75', '92', '93', '94'])
 * @returns         identifiants Allociné des salles acceptant les Cinéchèques
 */
export async function cinechequeTheaters(theaters, depts) {
  const page = await fetch(BASE, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!page.ok) throw new Error(`page HTTP ${page.status}`);
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const token = (await page.text()).match(/name="app_recherche_commune\[_token\]" value="([^"]+)"/)?.[1];
  if (!token) throw new Error('jeton du formulaire introuvable');

  const res = await fetch(BASE + 'search', {
    method: 'POST',
    headers: { 'User-Agent': UA, Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', Referer: BASE, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'app_recherche_commune[commune]': '', 'app_recherche_commune[_token]': token }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`recherche HTTP ${res.status}`);
  const all = (await res.json()).cinemas || [];

  const byName = new Map(Object.values(theaters).map((t) => [`${t.dept}|${norm(t.name)}`, t.id]));
  const ids = new Set();
  let unmatched = 0;
  for (const c of all.filter((c) => depts.includes(String(c.departement)))) {
    const id = String(c.allocine || '').match(/csalle=([A-Z0-9]+)/)?.[1];
    if (id && theaters[id]) ids.add(id);
    else {
      // Lien absent ou ancien identifiant : rattrapage par le nom dans le même département
      const n = norm(c.nom);
      const hit = byName.get(`${c.departement}|${n}`) || [...byName].find(([k]) => k.startsWith(c.departement + '|') && (k.endsWith(n) || k.includes(n)))?.[1];
      hit ? ids.add(hit) : unmatched++;
    }
  }
  console.log(`▸ Cinéchèques : ${ids.size} cinémas reconnus${unmatched ? `, ${unmatched} absents de notre liste` : ''}`);
  return [...ids].sort();
}
