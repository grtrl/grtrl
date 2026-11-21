# 📍 Mes listes Google Maps

Webapp perso pour **importer** tes listes Google Maps (via Google Takeout), les **organiser** sur une carte
avec tes notes et des filtres, et les **partager** avec tes potes — qui les ajoutent à leur appli Google Maps
en un clic sur **« Suivre »** (pas de Google My Maps, pas de fichier à importer).

## Lancer

```bash
cd maplists
npm install
npm start            # http://localhost:3000
```

Node 22.5+ requis (SQLite intégré à Node, aucune base à installer). Au premier accès, tu choisis ton mot de passe.

Avec Docker : `docker build -t maplists . && docker run -p 3000:3000 -v maplists-data:/data maplists`

Pour que tes potes y accèdent, il faut le mettre en ligne (VPS, Railway, Fly.io, Render…) **en HTTPS**,
avec un disque persistant pour le dossier `data/` (ou `DATA_DIR`).

## Comment ça marche

1. **Importer** – sur [takeout.google.com](https://takeout.google.com) : « Tout désélectionner », coche
   **Enregistré** (+ **Maps (vos adresses)** pour les lieux étoilés), télécharge le `.zip` et dépose-le dans le site.
   Réimporter plus tard met à jour les listes **sans perdre** tes notes, tags, étoiles et positions corrigées.
2. **Organiser** – carte avec une couleur par liste, recherche, filtres (tag, note, visité, non localisé,
   zone visible), tri, ta note perso, tags, étoiles, « déjà visité », placement manuel sur la carte.
3. **Partager** – bouton **👥 Amis** : chaque ami a son lien d'accès perso (sans mot de passe, révocable).
   Dans les réglages d'une liste, tu choisis : moi seul / tous mes amis / certains amis.
4. **Renvoyer vers Google Maps** – dans les réglages d'une liste, colle le lien de partage Google Maps
   (appli Google Maps → la liste → ⋮ → Partager la liste → Copier le lien, `https://maps.app.goo.gl/…`).
   Tes amis voient un gros bouton « Ouvrir dans Google Maps → Suivre ». Les liens Google My Maps sont refusés.

## Limites (côté Google)

- **Google ne fournit aucune API pour créer ou modifier des listes Google Maps.** Le site ne peut donc pas
  créer la liste dans Google Maps à ta place : la liste doit exister dans ton Google Maps, et tu colles une fois
  son lien de partage. Les changements faits ici (notes, tags, déplacement de liste…) restent sur le site.
- Le site ne peut pas non plus lire tes listes en direct : pour les mettre à jour, refais un export Takeout.
- Les CSV Takeout **ne contiennent pas de coordonnées**. Le serveur localise chaque lieu en tâche de fond :
  coordonnées dans l'URL → API Google Places (si `GOOGLE_MAPS_API_KEY`) → page Google Maps du lieu →
  OpenStreetMap/Nominatim par le nom (marqué « à vérifier »). Les lieux non trouvés se placent à la main.
  Pour une localisation fiable, mets une clé Google Places API (New) ; le palier gratuit suffit pour un usage perso.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `PORT` | Port HTTP (3000) |
| `DATA_DIR` | Dossier de la base SQLite (`./data`) |
| `ADMIN_PASSWORD` | Mot de passe imposé (sinon choisi au 1er accès) |
| `GOOGLE_MAPS_API_KEY` | Clé Places API (New) pour localiser les lieux précisément |
| `DISABLE_GOOGLE_PAGE=1` / `DISABLE_NOMINATIM=1` | Désactiver une méthode de localisation |

## Tests

```bash
npm test
```
