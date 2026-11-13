# Ma Pile

PWA perso pour noter ce que je veux acheter (livres, BD, jeux, Lego, objets), gérer une liste cadeaux, ranger ce qui est terminé sur des étagères et suivre mes lectures par mois.

- Front : HTML, CSS et JavaScript sans framework, hébergé sur GitHub Pages.
- Données : Supabase (base Postgres, stockage des photos, connexion par e-mail et mot de passe).
- Hors connexion : un service worker garde l'app et les photos déjà vues ; la dernière liste reste lisible.

## Installation

1. **Supabase** : dans le tableau de bord du projet, ouvre *SQL Editor*, colle le contenu de `supabase/schema.sql` et clique sur *Run*.
2. **Clés** : dans *Project Settings › API*, copie *Project URL* et la clé *anon public* dans `config.js`.
3. **Adresse du site** : dans *Authentication › URL Configuration*, mets `https://gg59fr.github.io/ma-pile/` comme *Site URL* et ajoute-la aux *Redirect URLs*.
4. **GitHub Pages** : *Settings › Pages*, source *Deploy from a branch*, branche `main`, dossier `/ (root)`.
5. **Premier compte** : ouvre le site, *Créer mon compte*, confirme l'e-mail, puis connecte-toi.
6. **Fermer les inscriptions** : dans *Authentication › Sign In / Providers*, désactive *Allow new users to sign up* pour que personne d'autre ne crée de compte.
7. **Sur l'iPhone** : ouvre le site dans Safari, bouton Partager › *Sur l'écran d'accueil*.

## Mettre à jour

Après une modification, change `VERSION` dans `sw.js` pour que les téléphones récupèrent les nouveaux fichiers.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | Écrans et menus |
| `styles.css` | Apparence (thème clair et sombre) |
| `app.js` | Logique de l'app, synchronisation Supabase, import Goodreads, sauvegarde |
| `config.js` | Adresse et clé publique Supabase |
| `sw.js` | Fonctionnement hors connexion |
| `manifest.webmanifest`, `icons/` | Installation sur l'écran d'accueil |
| `supabase/schema.sql` | Table, stockage des photos et règles d'accès |
