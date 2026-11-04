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

// PUT via XMLHttpRequest : fetch() ne donne pas la progression de l'envoi.
function putWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'image/jpeg');
    if (xhr.upload && typeof onProgress === 'function') {
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve()
      : reject(new WorkerError(`Échec de l'envoi vers le stockage (${xhr.status})`, xhr.status)));
    xhr.onerror = () => reject(new WorkerError('Connexion interrompue pendant l’envoi de la photo.', 0));
    xhr.ontimeout = () => reject(new WorkerError('L’envoi de la photo a pris trop de temps.', 0));
    xhr.timeout = 120000;
    xhr.send(file);
  });
}

// Upload direct navigateur -> R2 (scope: 'bookings' | 'incidents' | 'welcomer').
// Retourne l'objectKey à stocker dans Firestore à la place de downloadUrl.
export async function uploadPhotoToR2({ bookingId, scope, file, onProgress }) {
  const { uploadUrl, objectKey } = await workerFetch('/photos/upload-url', {
    method: 'POST',
    body: {
      bookingId,
      scope,
      filename: file.name || 'photo.jpg',
      contentType: file.type || 'image/jpeg',
    },
  });

  await putWithProgress(uploadUrl, file, onProgress);

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
