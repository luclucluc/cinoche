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
- **Filtres** (comme paris-cine.info) : jour ou semaine entière, heures, VO/VF, lieu (arrondissement, ville, rayon autour d'un point), cinémas (choix multiple), cartes illimitées, langue originale, genres, format (IMAX, 4DX, Dolby…). Les filtres peuvent se combiner.
- **Notes** en colonnes : IMDb, Allociné presse et spectateurs, SensCritique, Letterboxd, Metacritic, Rotten Tomatoes. Un clic sur l'en-tête d'une colonne trie par cette note.
- **Tri** : nombre de cinémas, chacune des notes, date de sortie, année, titre.
- **Recherche** sur le titre, le titre original, le réalisateur, les acteurs et le cinéma (touche `/`).
- L'URL est partageable (`#d=…&tab=…&view=…&q=…`). Elle ne contient jamais la position.

## Préférences (sans compte)

Le pictogramme en haut à droite ouvre les préférences :
- **thème** : clair, sombre ou réglage du système ;
- **films masqués par acteur ou réalisateur**, avec autocomplétion sur tous les noms du programme ;
- **enseignes masquées** : UGC, Pathé (et ex-Gaumont), MK2, CGR, Mégarama, Dulac Cinémas ([public/chains.js](public/chains.js)) ;
- **transfert** : export en fichier `.json` ou en code à copier-coller (`PC1:…`), puis import dans un autre navigateur ou un autre ordinateur.

Tout est stocké dans le `localStorage` du navigateur (clés `pc.*`) : préférences, favoris, cartes, position et rayon. Rien n'est envoyé à un serveur, et « Tout effacer » supprime tout.

Le filtre « Lieu » propose aussi un bloc « Autour de… » : on y choisit un point (sa position ou une adresse) et une distance, de 500 m à 10 km.

Seuls appels externes depuis le navigateur : le fond de carte OpenStreetMap, Leaflet (unpkg) et, quand vous saisissez une adresse, l'API Adresse de l'IGN (le texte saisi lui est transmis).

## Compte synchronisé (facultatif)

Dans **Compte → Données → Stockage des préférences**, chacun choisit :
- **Dans ce navigateur** (par défaut) : rien ne quitte le navigateur ;
- **Compte synchronisé** : connexion par **lien envoyé par e-mail** (sans mot de passe). Les préférences suivent sur tous les navigateurs et appareils : thème, favoris, films vus, masquages, notes, boutons affichés, cartes, position…

La synchronisation repose sur [Supabase](https://supabase.com) (offre gratuite). La version la plus récente l'emporte, et chaque modification est envoyée quelques secondes plus tard. On peut se déconnecter ou supprimer son compte depuis le même écran.

Mise en place, à faire une seule fois :
1. Créer un projet sur supabase.com, de préférence avec une région européenne (Paris : `eu-west-3`).
2. Ouvrir *SQL Editor*, coller le contenu de [supabase/schema.sql](supabase/schema.sql) et cliquer sur *Run*. Cela crée la table `preferences`, protégée pour que chacun ne voie que sa ligne.
3. Dans *Authentication → URL Configuration*, mettre `https://luclucluc.github.io/paris-cine/` en *Site URL* et dans les *Redirect URLs*.
4. Dans *Project Settings → API*, copier la **Project URL** et la clé **anon / publishable** dans [public/config.js](public/config.js). Cette clé est publique par conception : la protection vient des règles d'accès.

Tant que `public/config.js` est vide, le site fonctionne uniquement en mode « ce navigateur ».

## Données

Le scraper ([scraper/scrape.js](scraper/scrape.js)) interroge Allociné :

| Donnée | Source |
| --- | --- |
| Résolution des villes de banlieue | `/_/localization_city/{nom}` (JSON) |
| Liste des cinémas d'une ville | `/salle/cinema/ville-{id}/?page=N` (HTML) |
| Séances d'un cinéma pour un jour | `/_/showtimes/theater-{id}/d-{YYYY-MM-DD}/p-{N}/` (JSON) |
| Coordonnées GPS des cinémas | Géoplateforme IGN `data.geopf.fr/geocodage/search/csv`, en une requête groupée, avec un cache dans `scraper/geo-cache.json` |
| Note SensCritique | Wikidata (Allociné → SensCritique), sinon sitemap SensCritique + vérification sur la page du film (année, réalisateur) |
| Note IMDb | Jeux de données officiels IMDb (`title.ratings`, `title.basics`) ; identifiant via Wikidata ou titre + année + durée |
| Note Letterboxd | Redirection `letterboxd.com/imdb/<id>/` puis métadonnées de la page |
| Rotten Tomatoes / Metacritic | Wikidata, sinon adresse déduite du titre original et vérifiée (année, réalisateur) |
| Distribution complète (au-delà des 3 acteurs principaux d'Allociné) | Wikidata (P161), en requêtes groupées, avec un cache dans `.cache/cast.json` ; sert à la recherche et au masquage |

Les correspondances et les notes sont mises en cache dans `.cache/` (conservé d'une nuit à l'autre par GitHub Actions). Les notes sont rafraîchies tous les 2 jours pour les films récents, tous les 10 jours pour les autres.
Seules des pages autorisées par les `robots.txt` des sites sont consultées, à raison d'une requête par seconde et par site.
Pour récupérer les notes seules sur un `programme.json` existant : `npm run notes`.

Zones couvertes ([scraper/config.js](scraper/config.js)) : Paris et **toutes les communes des Hauts-de-Seine, de Seine-Saint-Denis et du Val-de-Marne**. La liste officielle des communes vient de geo.api.gouv.fr. Chaque commune est associée à sa ville Allociné ; cette correspondance est mise en cache, et la liste des cinémas de chaque ville est rafraîchie chaque semaine. On peut ajouter d'autres départements ou des villes isolées (`EXTRA_CITIES`).
Pour tester uniquement la découverte des cinémas : `node scraper/scrape.js --zones-only`.
Le scraper est volontairement lent (2 requêtes en parallèle, au moins 400 ms entre deux requêtes), et il se met en pause s'il reçoit une réponse 429. Un scraping complet sur 7 jours envoie environ 1 600 requêtes à Allociné et dure 30 à 40 minutes, car Allociné limite le débit.

Format de `programme.json` : `{ generatedAt, dates, theaters, movies, showtimes }`. Les cinémas portent leurs coordonnées `lat` et `lon`.
Pour géocoder seul un `programme.json` existant : `node scraper/geocode.js`.

Cartes ([public/cards.js](public/cards.js)) : UGC Illimité (UGC et MK2), CinéPass Pathé et cartes 5 places UGC et MK2 sont déduits de l'enseigne. La carte CIP repose sur la liste officielle des 32 salles adhérentes. La liste des salles acceptant les Cinéchèques est rechargée chaque nuit depuis la carte de [cinecheque.fr](https://www.cinecheque.fr/liste-des-cinemas/), qui donne directement l'identifiant Allociné de chaque salle. On peut y ajouter des salles partenaires.
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
