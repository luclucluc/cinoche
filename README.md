# paris·ciné

Le programme de tous les cinémas de Paris et de la proche banlieue, dans une interface minimaliste.
Inspiré de [paris-cine.info](https://paris-cine.info).

## Démarrage

```bash
npm run scrape        # récupère 7 jours de séances (~140 cinémas) → public/data/programme.json
npm start             # http://localhost:3000
```

`npm run scrape:quick` limite la récupération à Paris intra-muros sur 2 jours, pour tester.
Options : `node scraper/scrape.js --days 3 --paris-only`.

Aucune dépendance npm : il faut seulement Node ≥ 20.

## Fonctionnalités

- **Vues** : par film (avec toutes les séances par cinéma), par cinéma, ou **carte**.
- **Carte** : séances dans un rayon de 500 m à 10 km autour d'un point. Le point peut être votre position (géolocalisation du navigateur), une adresse (avec autocomplétion) ou un clic sur la carte. Le marqueur se déplace par glisser-déposer. Les cinémas sont triés par distance. Une fois le point défini, l'option « À moins de X de… » apparaît aussi dans le filtre de zone des autres vues.
- **Onglets** : tous les films, nouveautés (sorties depuis moins de 5 semaines), classiques (plus de 2 ans) et rétrospectives (réalisateurs ayant au moins 2 classiques à l'affiche).
- **Filtres** : jour, VO / VF, horaire (dès maintenant, après 18 h…), zone (arrondissement, ville de banlieue, un cinéma précis, ou « Mes cinémas »).
- **Tri** : nombre de cinémas, note presse, note spectateurs, date de sortie, ordre alphabétique.
- **Recherche** sur le titre, le titre original, le réalisateur, les acteurs et le cinéma (touche `/`).
- L'URL est partageable (`#d=…&tab=…&view=…&q=…`). Elle ne contient jamais la position.

## Pas de compte : tout reste dans le navigateur

Les préférences sont enregistrées dans le `localStorage` du navigateur (clés `pc.*`) :
cinémas favoris, position ou adresse, rayon, version VO/VF, zone et thème.
Rien n'est envoyé à un serveur, et le lien « Tout effacer » en pied de page supprime tout.
Contrepartie : ces préférences ne se synchronisent pas entre appareils.

Seuls appels externes depuis le navigateur : le fond de carte OpenStreetMap, Leaflet (unpkg) et, quand vous saisissez une adresse, l'API Adresse de l'IGN (le texte saisi lui est transmis).

## Données

Le scraper ([scraper/scrape.js](scraper/scrape.js)) interroge Allociné :

| Donnée | Source |
| --- | --- |
| Résolution des villes de banlieue | `/_/localization_city/{nom}` (JSON) |
| Liste des cinémas d'une ville | `/salle/cinema/ville-{id}/?page=N` (HTML) |
| Séances d'un cinéma pour un jour | `/_/showtimes/theater-{id}/d-{YYYY-MM-DD}/p-{N}/` (JSON) |
| Coordonnées GPS des cinémas | Géoplateforme IGN `data.geopf.fr/geocodage/search/csv`, en une requête groupée, avec un cache dans `scraper/geo-cache.json` |

Les villes couvertes se règlent dans [scraper/config.js](scraper/config.js).
Le scraper est volontairement lent (2 requêtes en parallèle, au moins 400 ms entre deux requêtes), et il se met en pause s'il reçoit une réponse 429. Un scraping complet sur 7 jours envoie environ 1 500 requêtes et dure une dizaine de minutes.

Format de `programme.json` : `{ generatedAt, dates, theaters, movies, showtimes }`. Les cinémas portent leurs coordonnées `lat` et `lon`.
Pour géocoder seul un `programme.json` existant : `node scraper/geocode.js`.
Chaque séance est un tableau compact : `[movieId, theaterId, "YYYY-MM-DDTHH:MM", "VO"|"VF", format]`.

Ces données appartiennent à Allociné et aux cinémas. Ce projet est destiné à un usage personnel. Avant toute mise en ligne publique, vérifiez les conditions d'utilisation d'Allociné.

## Fond de carte

Le fond de carte vient d'[OpenFreeMap](https://openfreemap.org) (tuiles OpenStreetMap vectorielles, gratuites, sans clé, utilisables sur un site public).
MapLibre l'affiche, Leaflet gère les marqueurs et le cercle. Deux styles sont utilisés, `positron` (clair) et `dark` (sombre), avec les libellés forcés en français.
Les bibliothèques ne sont chargées qu'à l'ouverture de la vue Carte.

## Hébergement (GitHub Pages)

Le workflow [.github/workflows/deploy.yml](.github/workflows/deploy.yml) récupère les séances puis publie `public/` sur GitHub Pages :
- chaque nuit (cron à 3 h 30 UTC) ;
- à chaque push sur `main` ;
- à la demande (onglet Actions → « Run workflow »).

Les données scrapées ne sont pas versionnées : elles ne vivent que dans l'artefact déployé.
Si le scraping récupère trop peu de séances (moins de 50 par jour en moyenne, réglable avec `MIN_SHOWTIMES`), le job échoue et le site garde la version précédente.

Mise en route, une seule fois : créer le dépôt, pousser `main`, puis **Settings → Pages → Source : GitHub Actions**.
Le site est ensuite servi à `https://<identifiant>.github.io/<dépôt>/`.

GitHub suspend les workflows planifiés d'un dépôt sans activité pendant 60 jours. Il suffit de les réactiver dans l'onglet Actions.
