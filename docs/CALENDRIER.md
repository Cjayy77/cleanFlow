# Calendriers connectés

Un client colle le lien iCal de son logement (Airbnb, Booking, Google Agenda, Smoobu…) dans la fiche logement. L'accueil client liste les départs de voyageurs des 90 prochains jours et propose "Réserver le ménage" pour le jour du départ.

- `api/ical.js` : fonction Vercel qui télécharge le flux pour un utilisateur connecté (jeton Firebase vérifié par l'API Google Identity). Elle refuse tout lien qui n'est pas en https, les adresses internes, les flux de plus de 1,5 Mo et les réponses de plus de 8 s. Aucun réglage Vercel n'est nécessaire : le dossier `api/` est déployé avec le site.
- `parseIcsEvents` et `icsDepartures` (dans `assets/js/shared.js`) lisent le flux. Les blocages du propriétaire ("Not available", "Blocked") sont ignorés. La date de ménage est la date de fin du séjour.
- Le calendrier n'est lu qu'en lecture seule. Rien n'est écrit chez Airbnb ou Google.

Limites : pas de connexion OAuth directe à Google Agenda (le lien iCal secret suffit), pas de réservation automatique, et un flux modifié par le client est relu au bout de 5 minutes au plus.
