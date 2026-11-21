# Listes Maps

Webapp mobile (PWA) pour importer mes listes Google Maps, les classer automatiquement par pays,
puis renvoyer un pays (ou une sélection) dans Google Maps sous forme de **vraie liste**.

## Couverture du cahier des charges (V1)

| ID | Fonctionnalité | Implémentation |
|----|----------------|----------------|
| F1 | Import Takeout | `.zip` Takeout complet, ou fichiers `.csv` (« Enregistré ») et `Saved Places.json` (« Maps (vos adresses) »). Les notes sont conservées. Réimporter met à jour sans dupliquer. |
| F2 | Import par lien | Lien `maps.app.goo.gl/…` d'une liste partagée → endpoint interne de Google Maps (non officiel). |
| F3 | Tri par pays | Géocodage inverse si le lieu a des coordonnées, sinon Places API (New) Text Search. En tâche de fond, avec barre de progression. |
| F4 | Doublons | Un lieu = une fiche (clé CID Google, puis place_id, puis coordonnées + nom). Il garde la trace de toutes ses listes d'origine. |
| F5 | Vue par pays | Pays + nombre de lieux, puis liste ou carte (Leaflet / OpenStreetMap). |
| F6 | Correction | Changer le pays, ajouter une note, retirer (et restaurer) un lieu. Une correction manuelle n'est jamais écrasée. |
| F7 | Export Google Maps | Automatisation de Google Maps web (Playwright) avec le compte dédié : création de la liste, ajout/retrait des lieux, mise à jour si la liste existe déjà. |
| F8 | Lien | Lien `maps.app.goo.gl` affiché, bouton « Ouvrir dans Google Maps » et « Copier ». |
| F9 | Statut | En attente / En cours (avec progression) / Réussi / Échec (message + capture d'écran). |
| F10 | Mobile | Interface pensée téléphone, installable (manifest + service worker). |

## Mise en route

### 1. En local (essai)

```bash
cd gmaps-lists
npm install
EXPORT_DRIVER=mock npm start      # exports simulés, sans compte Google
# → http://localhost:3000
```

Sans `GOOGLE_MAPS_API_KEY`, les lieux sans pays connu vont dans « À classer ».

### 2. Clé API Google Maps Platform

Dans Google Cloud Console : créer un projet, activer la facturation, activer **Places API (New)** et
**Geocoding API**, créer une clé (la restreindre à ces deux APIs). La mettre dans `GOOGLE_MAPS_API_KEY`.
Chaque lieu coûte un appel, une seule fois (le résultat est gardé en base).

### 3. Compte Google dédié (pour l'export)

Sur un **ordinateur** (pas le serveur) :

```bash
cd gmaps-lists && npm install && npx playwright install chromium
npm run google:login
```

Une fenêtre s'ouvre : se connecter au compte Gmail dédié, revenir au terminal, Entrée.
Puis dans l'app : **Réglages › Importer la session** et choisir `google-session.json`.
Ce fichier donne accès au compte dédié : ne pas le partager. Si Google invalide la session,
les exports échouent avec « session expirée » : refaire cette étape.

Les listes exportées appartiennent au compte dédié ; depuis mon compte, je les ouvre via le lien
et je les « suis » (bouton Suivre dans Google Maps).

### 4. Hébergement

L'export a besoin de Chromium et d'un disque persistant (base SQLite + session) : il faut un
hébergeur qui exécute un **conteneur Docker** avec un volume, pas un hébergement « serverless ».

```bash
docker build -t listes-maps .
docker run -p 3000:3000 -v listes-maps-data:/data \
  -e APP_PASSWORD=… -e GOOGLE_MAPS_API_KEY=… listes-maps
```

Options possibles : une petite VM (Oracle Cloud « Always Free », Google Cloud e2-micro), ou un PaaS
Docker avec volume (Fly.io, Railway, Render avec disque — offres gratuites à vérifier, elles changent souvent).
Toujours définir `APP_PASSWORD` et servir en HTTPS.

Sur le téléphone : ouvrir l'URL, puis « Ajouter à l'écran d'accueil ».

## Variables d'environnement

| Variable | Rôle |
|----------|------|
| `APP_PASSWORD` | Mot de passe de l'app (sans lui, l'app est ouverte à tous) |
| `GOOGLE_MAPS_API_KEY` | Tri par pays automatique |
| `DATA_DIR` | Dossier des données (défaut `./data`) |
| `EXPORT_DRIVER` | `mock` pour simuler les exports |
| `HEADLESS` | `false` pour voir le navigateur pendant un export (débogage en local) |
| `PORT` | Port HTTP (défaut 3000) |

## Points fragiles (à connaître)

- **Export (F7)** : Google n'a aucune API pour créer une liste. Le module
  `src/export/googleMapsDriver.js` clique dans Google Maps web comme un humain (interface forcée en anglais).
  C'est contraire aux conditions de Google et **cassera** quand l'interface changera : les sélecteurs sont
  regroupés dans ce fichier, et chaque échec garde une capture d'écran (visible depuis l'écran Exports).
  Les exports sont idempotents : relancer après un échec reprend sans créer de doublon.
- **Import par lien (F2)** : endpoint interne non documenté, même fragilité. L'import Takeout reste la voie fiable.
- **Pays mal détecté** : zones frontières, lieux homonymes (la recherche par nom prend le premier résultat).
  D'où « À classer » et la correction manuelle.

## Développement

```bash
npm test          # tests des parseurs et de l'API (résolveur et export simulés)
npm run dev       # serveur avec rechargement
npm run icons     # régénère les icônes PNG depuis public/icons/icon.svg
```

Structure :

```
src/server.js                 API + authentification + fichiers statiques
src/db.js                     SQLite (node:sqlite) : listes, lieux, exports
src/importers/takeout.js      F1
src/importers/sharedList.js   F2
src/resolver.js               F3 (Google Maps Platform) + tâche de fond
src/export/googleMapsDriver.js F7 (Playwright) + pilote simulé
src/export/jobs.js            F9 file d'exports
public/                       interface mobile (sans build)
scripts/google-login.js       connexion du compte dédié
```
