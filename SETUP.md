# Kleining — Mise en route (100% depuis le navigateur)

Hébergement : **Vercel** (site statique). Backend : **Firebase** (Auth,
Firestore, Storage). Aucune ligne de commande nécessaire — tout se fait
depuis les consoles web.

Déjà fait ✅ : projet Firebase créé, Firestore activé, connexion e-mail
activée. Reste à faire :

## 1. Activer Storage (photos de mission)

Console Firebase → **Storage** → *Commencer* (même région que Firestore).
> ⚠️ Depuis fin 2024, activer Storage sur un nouveau projet demande le plan
> **Blaze** (paiement à l'usage). Aux volumes de la bêta (quelques dizaines de
> photos par semaine), le coût réel est de l'ordre de zéro, mais une carte
> bancaire est requise.

## 2. Brancher l'application sur votre projet

1. Console Firebase → ⚙️ *Paramètres du projet* → *Vos applications* →
   **Ajouter une application Web** (`</>`), sans cocher Hosting.
2. Copiez l'objet `firebaseConfig` affiché.
3. Reportez chaque valeur dans **`firebase-config.js`** — directement depuis
   GitHub : ouvrez le fichier, cliquez sur le crayon (*Edit in place*),
   collez, validez le commit. Cette config n'est pas un secret : elle est
   faite pour être publique côté client ; la sécurité vient des règles
   Firestore/Storage.
4. Tant que le fichier n'est pas rempli, toutes les pages affichent un écran
   « configuration requise » au lieu de planter.

## 3. Publier les règles de sécurité (copier-coller)

Les règles font appliquer la séparation des rôles **côté serveur** — étape
indispensable avant de mettre de vraies données.

1. Ouvrez `firestore.rules` sur GitHub → bouton *Raw* → tout copier.
   Console Firebase → **Firestore Database** → onglet **Règles** → remplacez
   tout le contenu → **Publier**.
2. Idem avec `storage.rules` : console → **Storage** → onglet **Règles** →
   coller → **Publier**.

## 4. Autoriser le domaine Vercel pour la connexion

Console Firebase → **Authentication** → *Settings* → **Authorized domains** →
ajoutez votre domaine Vercel (ex. `kleining.vercel.app`) et, plus tard, votre
domaine personnalisé. Sans cela, la connexion échouera depuis le site.

## 5. Déployer sur Vercel

1. vercel.com → **Add New… → Project** → importez le dépôt GitHub
   `Cjayy77/cleanFlow`.
2. Framework preset : **Other** ; aucun build command, aucun output
   directory (site statique servi tel quel — `vercel.json` est déjà fourni).
3. Chaque push sur la branche de production redéploie automatiquement.

## 6. Comptes internes : demande → vérification → décision

Seuls les **clients** peuvent s'inscrire librement (sur `/app/`). Les rôles
prestataire, livreur et admin passent par un flux d'approbation :

1. La personne ouvre son interface (`/prestataire/`, `/livreur/` ou
   `/admin/`) → **« Demander un accès »** → remplit le formulaire et choisit
   son propre mot de passe. Aucun identifiant ne circule entre vous.
2. (Recommandé) Transmettez-lui au préalable un **code d'invitation** —
   n'importe quel code convenu entre vous (ex. `KLN-NET-07`). Elle le saisit
   dans sa demande : c'est votre preuve que c'est bien elle.
3. Dans `/admin/`, carte **« Demandes d'accès »** : contrôlez le code et les
   coordonnées, puis **Approuver** ou **Refuser**. Tant que la demande n'est
   pas approuvée, le compte ne peut strictement rien lire ni écrire — c'est
   imposé par les règles Firestore, pas seulement par l'interface.

**Seul le tout premier compte admin** doit être créé à la main dans la
console (il faut un admin pour approuver les autres) :

1. Console Firebase → **Authentication** → *Users* → **Add user** →
   votre email + un mot de passe → **Add user**.
2. La liste affiche le nouvel utilisateur : copiez la valeur de la colonne
   **User UID** (icône copier au survol).
3. **Firestore Database** → **+ Démarrer une collection** → ID de collection :
   `users` → ID du **document** : collez l'UID (ne laissez pas l'ID
   auto-généré) → ajoutez les champs (tous de type *string*) :
   - `uid` = l'UID collé encore une fois
   - `role` = `admin`
   - `accountStatus` = `approved`
   - `name` = votre nom
   - `email` = le même email qu'à l'étape 1
   - `phone` = votre numéro
4. Ouvrez `/admin/` sur votre site, connectez-vous : vous y êtes. Toutes les
   autres personnes passent par la demande d'accès.

## 7. Notifications e-mail (extension à installer, sans code)

L'application dépose chaque notification dans une collection Firestore
`mail`. Pour qu'elles partent réellement par e-mail, installez l'extension
officielle **Trigger Email from Firestore** — entièrement depuis le
navigateur :

1. Console Firebase → **Extensions** → rechercher **« Trigger Email from
   Firestore »** (éditeur : Firebase) → **Installer** (nécessite Blaze, déjà
   requis pour Storage).
2. Configuration demandée :
   - *Email documents collection* : `mail`
   - *SMTP connection URI* : les identifiants SMTP de votre fournisseur.
     Le plus simple : un compte gratuit **Brevo** ou **SendGrid** (SMTP
     fourni en 5 minutes), ou le SMTP Gmail avec un « mot de passe
     d'application ».
   - *Default FROM address* : ex. `Kleining <w.wanecque@gmail.com>`.
3. C'est tout. Sans l'extension, l'application fonctionne normalement — les
   notifications s'accumulent simplement dans la collection `mail` sans
   partir.

Notifications envoyées : nouvelle réservation, annulation, dossier photos
soumis et demande d'accès → **boîte de l'équipe** (`w.wanecque@gmail.com`,
adresse codée dans `assets/js/shared.js` **et** dans `firestore.rules`,
modifier les deux ensemble) ; ménage confirmé → **client** ; dossier à
corriger → **prestataire**. La réinitialisation de mot de passe (« Mot de
passe oublié ? ») passe par Firebase Auth directement, sans l'extension —
personnalisez ce modèle dans Authentication → Templates.

## 8. Les quatre interfaces

| Rôle | URL | Accès |
|---|---|---|
| Client | `/app/` | lien public, auto-inscription |
| Prestataire | `/prestataire/` | lien direct à partager, accès sur demande approuvée |
| Livreur | `/livreur/` | lien direct à partager, accès sur demande approuvée |
| Admin (vérification) | `/admin/` | lien direct à partager, accès sur demande approuvée |

## 9. Parcours d'une réservation

`pending` (réservé par le client) → `accepted` (prestataire) → `submitted`
(photos envoyées) → `verified` **ou** `rejected` (décision humaine dans
`/admin/`). Un dossier rejeté revient chez le prestataire avec la note de
l'admin ; il corrige les photos et re-soumet.

Le client peut annuler sa réservation (statut `cancelled`) uniquement tant
qu'elle est `pending` ; ensuite l'annulation passe par l'équipe. Un
prestataire peut se désister d'une mission `accepted` : elle redevient
`pending` et l'équipe est notifiée. Le livreur coche ses tournées de linge
(champ `linenDone`). Ces contraintes sont appliquées par les règles
Firestore.

> Note : le cahier des charges nommait ce statut `completed` ; le code
> existant utilisait déjà `submitted`, convention conservée.

## 10. Rétention des photos — 90 jours (processus manuel)

Pas de Cloud Function pour la bêta (choix documenté) : une fois par mois,
dans **Storage → `bookings/`**, supprimer les dossiers des réservations de
plus de 90 jours, et purger les documents `photos` correspondants dans
Firestore.

## Hors périmètre bêta (volontairement non construit)

- Paiements (gérés directement avec l'équipe), tracking GPS, vérification
  automatique/IA, import Airbnb, intégrations calendrier tierces.
