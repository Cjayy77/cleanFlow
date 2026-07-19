# Kleining — Mise en route Firebase

Tout le code est prêt : il ne manque que la configuration de votre projet
Firebase. Comptez ~15 minutes.

## 1. Créer le projet Firebase

1. Allez sur https://console.firebase.google.com → **Ajouter un projet** (nom : `kleining`).
2. Dans le projet, activez :
   - **Authentication** → onglet *Sign-in method* → activer **E-mail/Mot de passe**.
   - **Firestore Database** → *Créer une base* → mode **production** → région `europe-west9` (Paris).
   - **Storage** → *Commencer* → mode production, même région.

## 2. Brancher l'application

1. Dans *Paramètres du projet* → *Vos applications* → **Ajouter une application Web** (`</>`), sans hosting coché.
2. Copiez l'objet `firebaseConfig` affiché et collez ses valeurs dans **`firebase-config.js`** (remplacez chaque `REPLACE_WITH_...`).
3. Tant que ce fichier n'est pas rempli, toutes les pages affichent un écran « configuration requise » au lieu de planter.

## 3. Déployer les règles et le site

```bash
npm install -g firebase-tools
firebase login
firebase use --add        # sélectionnez le projet kleining
firebase deploy           # déploie hosting + firestore.rules + storage.rules
```

Les règles Firestore/Storage font appliquer la séparation des rôles **côté
serveur** : un client ne peut pas lire les données prestataire/admin même en
appelant l'API directement.

## 4. Créer les comptes internes

Seuls les **clients** peuvent s'inscrire eux-mêmes (sur `/app/`). Les règles
refusent tout autre rôle à l'auto-inscription. Pour chaque compte
prestataire, livreur ou admin :

1. **Authentication** → *Users* → **Add user** (email + mot de passe). Copiez l'**UID** créé.
2. **Firestore** → collection `users` → **Ajouter un document** avec l'UID comme ID de document :

```
uid:   <le même UID>
role:  "admin"        (ou "prestataire" / "livreur")
name:  "Équipe Kleining"
email: <le même email>
phone: "06..."
```

## 5. Les quatre interfaces

| Rôle | URL | Accès |
|---|---|---|
| Client | `/app/` | lien public depuis le site vitrine, auto-inscription |
| Prestataire | `/prestataire/` | lien direct à partager, compte créé à la main |
| Livreur | `/livreur/` | lien direct à partager, compte créé à la main |
| Admin (vérification) | `/admin/` | lien direct à partager, compte créé à la main |

Aucune des trois interfaces privées n'est liée depuis la navigation publique,
et chacune vérifie le rôle du compte connecté (en plus des règles serveur).

## 6. Parcours d'une réservation

`pending` (réservé par le client) → `accepted` (prestataire) → `submitted`
(photos envoyées) → `verified` **ou** `rejected` (décision humaine dans
`/admin/`). Un dossier rejeté revient chez le prestataire avec la note de
l'admin ; il corrige les photos et re-soumet.

> Note : le cahier des charges nommait ce statut `completed` ; le code
> existant utilisait déjà `submitted`, convention conservée.

## 7. Rétention des photos — 90 jours (processus manuel)

Pas de Cloud Function pour la bêta (choix documenté) : une fois par mois,
dans **Storage → `bookings/`**, supprimer les dossiers des réservations de
plus de 90 jours. Les documents `photos` correspondants peuvent être purgés
dans Firestore au même moment.

## Hors périmètre bêta (volontairement non construit)

- Paiements (marquage manuel), tracking GPS, vérification automatique/IA,
  import Airbnb, intégrations calendrier tierces.
- Notification e-mail du client à la validation : à confirmer avec l'équipe
  (pour l'instant le statut « Confirmé » apparaît dans l'espace client).
