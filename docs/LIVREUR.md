# Preuve de livraison (livreur)

Quand un livreur confirme une livraison, l'application enregistre l'heure (`deliveredAt`) et une photo (`deliveryPhotoKey`, clé R2) sur la réservation. L'admin les voit dans Vérification, onglet "Logement et prix".

## À faire hors de ce dépôt

- Republier `firestore.rules` dans la console Firebase (le livreur peut maintenant écrire `deliveredAt` et `deliveryPhotoKey`).
- Worker R2 : accepter le scope `deliveries` sur `/photos/upload-url`, `/photos/verify` et `/photos/download-url`. Autoriser en écriture le livreur dont `bookings/{bookingId}.livreurId` est l'uid de l'appelant, et en lecture ce livreur et les admins. Sans cela, le livreur reçoit un 403 et la livraison n'est pas enregistrée.
