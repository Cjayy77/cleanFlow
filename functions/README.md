# Zebramoon — Cloud Functions (backend)

Ce dossier contient le **backend** Zebramoon (Firebase Cloud Functions, Node 20).
Il est **livré prêt à déployer mais pas encore mis en ligne** : le déploiement
demande des accès et des comptes que seul l'administrateur possède.

## ⚠️ Prérequis (à faire une seule fois)

1. **Passer le projet Firebase au plan Blaze** (pay-as-you-go).
   Les Cloud Functions ne tournent pas sur le plan gratuit (Spark).
2. Installer la CLI Firebase et se connecter :
   ```
   npm i -g firebase-tools
   firebase login
   ```
3. Renseigner l'ID du projet dans **`.firebaserc`** (remplacer le placeholder),
   ou lancer `firebase use --add`.
4. Installer les dépendances :
   ```
   cd functions && npm install
   ```

## Déploiement

```
firebase deploy --only functions      # les fonctions
firebase deploy --only firestore:rules,storage:rules   # les règles (aussi éditables en console)
```

## Ce que fait le backend

| Fonction | Rôle | État |
|---|---|---|
| `sendDevisOnBooking` | À chaque réservation, génère le **devis PDF** et l'envoie par email au client (+ copie équipe) via l'extension *Trigger Email*. | ✅ prêt |
| `prospectFromDevisRequest` | Crée automatiquement une **fiche prospect** (CRM) depuis une demande de devis du site. | ✅ prêt |
| `api` | **API REST** de lecture (ex. `GET /stats`), protégée par clé — base des futures connexions Airbnb/Booking. | 🟡 squelette |
| `createCheckoutSession` | **Paiement Stripe**. | 🔴 PLACEHOLDER — aucun compte Stripe créé pour l'instant |
| `relayNewProspect` | Relaie chaque nouveau prospect vers **Make/Zapier/HubSpot/Pennylane**. | 🟡 no-op tant qu'aucun webhook n'est configuré |

## Secrets / variables à définir (avant usage réel)

Le paiement et les intégrations sont **désactivés par défaut** (placeholders).
Ils s'activent en définissant les variables d'environnement correspondantes :

```
firebase functions:secrets:set STRIPE_SECRET          # clé secrète Stripe (à créer)
firebase functions:secrets:set API_KEY                # clé de l'API REST
firebase functions:secrets:set INTEGRATIONS_WEBHOOK   # URL Make/Zapier (optionnel)
```

Tant que `STRIPE_SECRET` n'est pas défini, `createCheckoutSession` renvoie
« Paiement non configuré » — c'est volontaire.

## Important — non testé en live

Ce code est **valide et documenté** mais n'a pas pu être exécuté dans
l'environnement de développement (pas d'accès de déploiement, pas de compte
Stripe). Après le premier `firebase deploy`, vérifier :
- qu'un email de devis part bien à la création d'une réservation de test ;
- qu'une demande de devis crée bien un prospect ;
- (plus tard) le flux de paiement une fois Stripe branché.
