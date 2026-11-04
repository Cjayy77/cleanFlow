# Équipes prestataires

Un prestataire est une équipe. Le chef d'opération (rôle `prestataire`, uid = identifiant d'équipe) reçoit les missions de l'admin. Ses équipiers (rôle `membre`, champ `teamId` = uid du chef) ont chacun leur compte sur leur téléphone.

## Parcours

1. Le chef copie le lien d'invitation de sa carte "Mon équipe" (`/prestataire/?equipe=<uid>`).
2. L'équipier crée son compte via ce lien. Le chef l'accepte dans la même carte.
3. L'admin assigne la mission à l'équipe (au chef).
4. Le chef répartit chaque bloc de la checklist (une pièce ou une phase) entre ses équipiers. Les répartitions sont dans `missionTasks`.
5. Chaque équipier voit ses blocs, répond et envoie les photos. Le chef soumet le dossier, Zebramoon paie l'équipe, le chef répartit la somme.

## À faire hors de ce dépôt

- Republier `firestore.rules` dans la console Firebase.
- Worker R2 (`/photos/upload-url`, `/photos/verify`, `/photos/download-url`) : accepter aussi l'appelant dont `users/{uid}.teamId == booking.prestataireId`. Sans cela, les photos des équipiers reçoivent un 403.
