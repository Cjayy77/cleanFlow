## Zebramoon  

Le ménage vérifié pour les locations saisonnières à Paris. Réservation par
calendrier, dossier photo obligatoire, contrôle humain par l'équipe Zebramoon
avant toute confirmation au client.

## Structure 

```
index.html            Site vitrine public
app/                  Espace client (auto-inscription)
prestataire/          Interface prestataire (lien direct, compte créé à la main)
livreur/              Interface livreur (lien direct, compte créé à la main)
admin/                File de vérification Zebramoon (lien direct, compte créé à la main)
legal/                CGU + politique de confidentialité
assets/               ui.css partagé + JS des quatre interfaces
firebase-config.js    Config du projet Firebase (à remplir — voir SETUP.md)
firestore.rules       Règles Firestore (à coller dans la console — voir SETUP.md)
storage.rules         Règles Storage (à coller dans la console — voir SETUP.md)
vercel.json           Config de l'hébergement Vercel
```

Hébergement : **Vercel** (site statique, zéro build). Backend : **Firebase**
(Auth, Firestore, Storage) via modules ES chargés depuis le CDN. Toute la
mise en route se fait depuis le navigateur : voir **SETUP.md**.

⚠️ Ce dépôt est déployé publiquement tel quel par Vercel. N'y commitez
jamais de documents internes (business plan, prévisionnel, etc.).
