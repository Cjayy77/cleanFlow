# Kleining

Le ménage vérifié pour les locations saisonnières à Paris. Réservation par
calendrier, dossier photo obligatoire, contrôle humain par l'équipe Kleining
avant toute confirmation au client.

## Structure

```
index.html            Site vitrine public
app/                  Espace client (auto-inscription)
prestataire/          Interface prestataire (lien direct, compte créé à la main)
livreur/              Interface livreur (lien direct, compte créé à la main)
admin/                File de vérification Kleining (lien direct, compte créé à la main)
assets/               ui.css partagé + JS des quatre interfaces
firebase-config.js    Config du projet Firebase (à remplir — voir SETUP.md)
firestore.rules       Règles Firestore (séparation des rôles côté serveur)
storage.rules         Règles Storage (photos de mission, incidents)
```

Backend : Firebase (Auth, Firestore, Storage), sans framework ni build —
des modules ES chargés depuis le CDN. Voir **SETUP.md** pour la mise en route.

⚠️ Ce dépôt est déployé publiquement par Firebase Hosting (`"public": "."`).
N'y commitez jamais de documents internes (business plan, prévisionnel, etc.).
