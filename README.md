# Ma Pile

PWA perso pour gérer ma collection (Lego, jeux, livres, BD, objets), noter mes envies, partager une liste cadeaux et suivre mes lectures.

- Front : HTML, CSS et JavaScript sans framework, hébergé sur GitHub Pages.
- Données : Supabase (base Postgres, stockage des photos, connexion par e-mail et mot de passe).
- Hors connexion : un service worker garde l'app et les photos déjà vues ; la dernière liste reste lisible.

## Installation

1. **Base Supabase** : déjà créée (projet `gxeaueokgolhgulaqodk`) avec `supabase/schema.sql`. Pour un nouveau projet : *SQL Editor*, coller le fichier, *Run*, puis renseigner `config.js`.
2. **Mon compte** : *Authentication › Users › Add user › Create new user*, avec *Auto Confirm User* coché.
3. **Fermer les inscriptions** : *Authentication › Sign In / Providers*, désactiver *Allow new users to sign up*.
4. **GitHub Pages** : *Settings › Pages*, source *Deploy from a branch*, branche `main`, dossier `/ (root)`. Le site est servi sur `https://gg59fr.github.io/ma-pile/`.
5. **Sur l'iPhone** : ouvrir le site dans Safari, se connecter, puis Partager › *Sur l'écran d'accueil*.
6. **Reprendre la version de test** : dans l'app, bouton compte › *Importer une sauvegarde*.

## Mettre à jour

Après une modification, change `VERSION` dans `sw.js` pour que les téléphones récupèrent les nouveaux fichiers.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | Écrans et menus |
| `styles.css` | Apparence (thème clair et sombre) |
| `app.js` | Logique de l'app, synchronisation Supabase, couvertures, scan ISBN, partage, import Goodreads, sauvegarde |
| `config.js` | Adresse et clé publique Supabase |
| `cadeaux.html`, `cadeaux.js` | Page publique de la liste cadeaux (réservations) |
| `sw.js` | Fonctionnement hors connexion |
| `manifest.webmanifest`, `icons/` | Installation sur l'écran d'accueil |
| `supabase/schema.sql` | Table, stockage des photos et règles d'accès |
| `supabase/functions/lego-catalog-sync` | Fonction serveur qui recharge le catalogue Lego (Rebrickable) |
