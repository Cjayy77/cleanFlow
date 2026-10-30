// Zebramoon, couche d'upload photo vers Cloudflare R2 via le Worker
// zebramoon-worker (remplace Firebase Storage, qui exige le plan Blaze).
// Flow : le navigateur demande une URL PUT pré-signée au Worker, envoie le
// fichier directement à R2, puis demande au Worker de vérifier l'upload.
// Les métadonnées (bookingId, objectKey...) restent écrites dans Firestore
// exactement comme avant : seul le transport du fichier change.
import { auth } from './shared.js';

// URL du Worker Cloudflare, déployé sur le compte où R2 est activé.
// À remplacer par un sous-domaine personnalisé (ex. api.zebramoon.fr) si besoin.
export const WORKER_BASE_URL = 'https://zebramoon-worker.cedricjulien77-70b.workers.dev';

class WorkerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function workerFetch(path, { method = 'GET', body } = {}) {
  const user = auth.currentUser;
  if (!user) throw new WorkerError('Non connecté', 401);
  const idToken = await user.getIdToken();

  const res = await fetch(`${WORKER_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* réponse vide */ }

  if (!res.ok) {
    throw new WorkerError((data && data.error) || `Erreur serveur (${res.status})`, res.status);
  }
  return data;
}

// Upload direct navigateur -> R2 (scope: 'bookings' | 'incidents' | 'welcomer').
// Retourne l'objectKey à stocker dans Firestore à la place de downloadUrl.
export async function uploadPhotoToR2({ bookingId, scope, file }) {
  const { uploadUrl, objectKey } = await workerFetch('/photos/upload-url', {
    method: 'POST',
    body: {
      bookingId,
      scope,
      filename: file.name || 'photo.jpg',
      contentType: file.type || 'image/jpeg',
    },
  });

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'image/jpeg' },
    body: file,
  });
  if (!putRes.ok) throw new WorkerError(`Échec de l'envoi vers le stockage (${putRes.status})`, putRes.status);

  await workerFetch('/photos/verify', { method: 'POST', body: { bookingId, scope, objectKey } });

  return objectKey;
}

// Les objets R2 sont privés : on redemande une URL de lecture signée (de
// courte durée) à chaque affichage plutôt que de stocker une URL permanente.
export async function getPhotoDownloadUrl({ bookingId, scope, objectKey }) {
  const params = new URLSearchParams({ bookingId, scope, objectKey });
  const { url } = await workerFetch(`/photos/download-url?${params.toString()}`);
  return url;
}

// Résout record.downloadUrl (ancien champ Firebase Storage) OU
// record.objectKey / record.photoKey (nouveau champ R2, le nom varie selon
// la collection) vers une <img src> affichable. Permet une migration
// progressive sans casser les photos déjà en base.
export async function resolvePhotoUrl(record, { bookingId, scope }) {
  if (!record) return '';
  const objectKey = record.objectKey || record.photoKey;
  if (objectKey) {
    try {
      return await getPhotoDownloadUrl({ bookingId, scope, objectKey });
    } catch {
      return '';
    }
  }
  return record.downloadUrl || '';
}
