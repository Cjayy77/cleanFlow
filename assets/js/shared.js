// Kleining — couche de données Firebase partagée par les quatre interfaces.
// Firestore = données, Firebase Auth = connexion, Firebase Storage = photos.
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
import { firebaseConfig } from '../../firebase-config.js';

export const ROLE_CLIENT = 'client';
export const ROLE_PRESTATAIRE = 'prestataire';
export const ROLE_LIVREUR = 'livreur';
export const ROLE_ADMIN = 'admin';

// Grille tarifaire (barème de William). Le prix de la prestation dépend de la
// surface du logement (m²) et du type de ménage. Source unique de vérité :
// modifier ici met à jour le portail client et l'affichage admin.
export const PRICE_BANDS = [
  { max: 30, label: '0–30 m²', normal: 42, deep: 67 },
  { max: 40, label: '31–40 m²', normal: 49, deep: 74 },
  { max: 55, label: '41–55 m²', normal: 63, deep: 88 },
  { max: 75, label: '56–75 m²', normal: 74, deep: 99 },
  { max: 120, label: '76–120 m²', normal: 83, deep: 108 },
  { max: 150, label: '121–150 m²', normal: 97, deep: 132 },
  { max: 250, label: '151–250 m²', normal: 115, deep: 160 },
];
// Au-delà de 250 m² : tarif sur-mesure (devis), pas de prix automatique.

export const KIT_PRICE = 20; // par kit (linge, consommables), à l'unité.

// Frais de déplacement. Provisoire : forfait unique. William fournira une
// grille par zone (plus la zone est éloignée, plus les frais sont élevés) ;
// il suffira alors de faire dépendre travelFeeForZone() de la zone.
export const TRAVEL_FEE = 10;

// Zones = classification / assignation (et, plus tard, frais de déplacement).
// N'influencent PAS le prix de la prestation. Liste provisoire, ajustable.
export const ZONES = [
  { value: 'paris', label: 'Paris (intra-muros)' },
  { value: 'petite_couronne', label: 'Petite couronne (92 · 93 · 94)' },
  { value: 'grande_couronne', label: 'Grande couronne (77 · 78 · 91 · 95)' },
];

export function zoneLabel(value) {
  return (ZONES.find(z => z.value === value) || {}).label || value || '';
}

export function travelFeeForZone(/* zone */) {
  // Provisoire : forfait unique quelle que soit la zone.
  return TRAVEL_FEE;
}

// Trouve la tranche de surface. Renvoie { custom:true } au-delà de 250 m².
export function bandForSurface(surface) {
  const s = Number(surface);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (s > 250) return { custom: true, label: '+250 m²' };
  return PRICE_BANDS.find(band => s <= band.max) || null;
}

// Calcule le détail de prix d'une réservation. Renvoie null si la surface est
// invalide, ou { custom:true } si elle relève du devis sur-mesure.
export function computeBookingPrice({ surface, serviceType, kitCount = 0, zone }) {
  const band = bandForSurface(surface);
  if (!band) return null;
  if (band.custom) return { custom: true, band };
  const service = serviceType === 'deep' ? 'deep' : 'normal';
  const kits = Math.max(0, Math.floor(Number(kitCount) || 0));
  const prestation = band[service];
  const kitsTotal = kits * KIT_PRICE;
  const travel = travelFeeForZone(zone);
  return {
    custom: false,
    band,
    serviceType: service,
    prestation,
    kitCount: kits,
    kitsTotal,
    travel,
    total: prestation + kitsTotal + travel,
  };
}

// Boîte de réception de l'équipe pour les notifications internes.
// Doit rester identique à l'adresse autorisée dans firestore.rules (/mail).
export const TEAM_EMAIL = 'w.wanecque@gmail.com';

// TODO: confirm with team — liste exacte des photos exigées par mission.
export const PHOTO_SLOTS = [
  { key: 'kitchen_before', label: 'Cuisine — avant' },
  { key: 'kitchen_after', label: 'Cuisine — après' },
  { key: 'bathroom', label: 'Salle de bain' },
  { key: 'bedroom1', label: 'Chambre 1' },
  { key: 'bedroom2', label: 'Chambre 2' },
  { key: 'linen', label: 'Linge changé' },
];

const configMissing = Object.values(firebaseConfig).some(value => String(value).startsWith('REPLACE'));
if (configMissing) {
  const renderNotice = () => {
    document.body.innerHTML = `
      <div style="max-width:560px;margin:80px auto;padding:36px;font-family:sans-serif;border:1px solid #DCE1EE;border-radius:8px;background:#fff;color:#10131A;">
        <div style="font-family:monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#002FA7;margin-bottom:12px;">Kleining — configuration requise</div>
        <h1 style="font-size:20px;margin:0 0 12px;">Firebase n'est pas encore configuré</h1>
        <p style="line-height:1.6;color:#5A6472;">Copiez la configuration web de votre projet Firebase dans <code>firebase-config.js</code>, puis rechargez la page. Les étapes complètes sont dans <code>SETUP.md</code>.</p>
      </div>`;
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNotice);
  } else {
    renderNotice();
  }
  throw new Error('Firebase non configuré — voir SETUP.md');
}

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
// Sans ces limites, le SDK réessaie ~2 min avant d'abandonner (ex. bucket
// Storage non activé) : l'échec est ramené à ~12 s avec un vrai code d'erreur.
storage.maxUploadRetryTime = 12000;
storage.maxOperationRetryTime = 12000;

export async function loadUserDoc(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

// Seuls les clients peuvent créer un compte eux-mêmes ; les comptes
// prestataire/livreur/admin sont créés manuellement (voir SETUP.md) et les
// règles Firestore refusent tout autre rôle à l'auto-inscription.
export async function registerClient({ name, email, password, phone }) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await setDoc(doc(db, 'users', credential.user.uid), {
    uid: credential.user.uid,
    role: ROLE_CLIENT,
    name,
    email,
    phone,
    accountStatus: 'approved',
    createdAt: serverTimestamp(),
  });
  return credential.user;
}

export async function loadPhotoDocs(bookingId) {
  const snap = await getDocs(query(collection(db, 'photos'), where('bookingId', '==', bookingId)));
  return snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function loadIncidentDocs(bookingId) {
  const snap = await getDocs(query(collection(db, 'incidents'), where('bookingId', '==', bookingId)));
  return snap.docs
    .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
    .sort((a, b) => (b.reportedAt?.toMillis?.() || 0) - (a.reportedAt?.toMillis?.() || 0));
}

// Une photo par emplacement : re-téléverser le même emplacement remplace la
// précédente (utile quand l'admin rejette le dossier).
export async function uploadBookingImage({ bookingId, slot, file, uploadedBy }) {
  const normalizedSlot = slot.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const storagePath = `bookings/${bookingId}/${normalizedSlot}`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, file, { contentType: file.type || 'image/jpeg' });
  const downloadUrl = await getDownloadURL(storageRef);
  const photoDoc = {
    bookingId,
    slot: normalizedSlot,
    uploadedBy,
    storagePath,
    downloadUrl,
    uploadedAt: serverTimestamp(),
    verified: false,
  };
  await setDoc(doc(db, 'photos', `${bookingId}_${normalizedSlot}`), photoDoc);
  return photoDoc;
}

export function formatShortDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatBookingStatus(status) {
  switch (status) {
    case 'pending': return 'En attente';
    case 'accepted': return 'Accepté';
    case 'submitted': return 'Photos soumises';
    case 'verified': return 'Confirmé';
    case 'rejected': return 'À corriger';
    case 'cancelled': return 'Annulée';
    default: return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

// Demande d'accès prestataire/livreur/admin : crée le compte en statut
// "pending", invisible et sans droits tant qu'un admin ne l'a pas approuvé
// dans /admin/. Passe par une seconde instance Firebase pour ne pas toucher
// à la session en cours sur la page.
export async function requestTeamAccess({ role, name, email, password, phone, inviteCode }) {
  const secondary = initializeApp(firebaseConfig, `access-request-${Date.now()}`);
  const secondaryAuth = getAuth(secondary);
  const secondaryDb = getFirestore(secondary);
  try {
    const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await setDoc(doc(secondaryDb, 'users', credential.user.uid), {
      uid: credential.user.uid,
      role,
      name,
      email,
      phone,
      inviteCode: inviteCode || '',
      accountStatus: 'pending',
      createdAt: serverTimestamp(),
    });
    await addDoc(collection(secondaryDb, 'mail'), {
      to: TEAM_EMAIL,
      message: {
        subject: `Kleining — nouvelle demande d’accès ${role}`,
        text: `${name} (${email}, ${phone}) demande un accès ${role}.${inviteCode ? ` Code d’invitation saisi : ${inviteCode}.` : ' Aucun code d’invitation saisi.'} À traiter dans /admin/.`,
      },
      createdAt: serverTimestamp(),
    }).catch(() => {});
    return credential.user.uid;
  } finally {
    await signOut(secondaryAuth).catch(() => {});
    await deleteApp(secondary).catch(() => {});
  }
}

// E-mail de réinitialisation du mot de passe (flux natif Firebase).
export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

// File d'envoi d'e-mails : dépose un document dans la collection `mail`,
// que l'extension Firebase « Trigger Email » transforme en vrai e-mail
// (voir SETUP.md). Sans l'extension, les documents s'accumulent sans effet —
// l'action métier n'échoue jamais à cause d'un e-mail.
export function queueEmail({ to, subject, text }) {
  return addDoc(collection(db, 'mail'), {
    to,
    message: { subject, text },
    createdAt: serverTimestamp(),
  }).catch(() => {});
}

// État visuel de chargement d'un bouton pendant une action asynchrone.
export async function withButtonLoading(button, task) {
  if (button) button.classList.add('loading');
  try {
    return await task();
  } finally {
    if (button) button.classList.remove('loading');
  }
}

// Coupe une promesse qui ne répond pas (ex. upload vers un bucket Storage
// inexistant : le SDK réessaie longtemps au lieu d'échouer franchement).
export function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => {
      const err = new Error('timeout');
      err.code = 'app/timeout';
      reject(err);
    }, ms)),
  ]);
}

export function storageErrorMessage(error) {
  switch (error?.code) {
    case 'storage/unauthorized':
      return 'Envoi refusé par les règles de sécurité. Vérifiez que les règles Storage sont publiées dans la console Firebase.';
    case 'storage/retry-limit-exceeded':
    case 'app/timeout':
      return 'Le stockage de photos ne répond pas. Il n’est probablement pas activé sur le projet Firebase (Storage, plan Blaze). Voir SETUP.md, étape 1.';
    case 'storage/quota-exceeded':
      return 'Quota de stockage dépassé.';
    case 'storage/canceled':
      return 'Envoi annulé.';
    default:
      return authErrorMessage(error);
  }
}

export function authErrorMessage(error) {
  switch (error?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email ou mot de passe incorrect.';
    case 'auth/email-already-in-use':
      return 'Un compte existe déjà avec cette adresse.';
    case 'auth/weak-password':
      return 'Mot de passe trop court (6 caractères minimum).';
    case 'auth/invalid-email':
      return 'Adresse email invalide.';
    case 'auth/too-many-requests':
      return 'Trop de tentatives. Réessayez dans quelques minutes.';
    case 'auth/network-request-failed':
    case 'unavailable':
      return 'Problème de connexion. Vérifiez votre réseau et réessayez.';
    case 'permission-denied':
      return 'Accès refusé par la base de données. Les règles Firestore ne sont probablement pas publiées (voir SETUP.md, étape 3).';
    default:
      return error?.message || 'Une erreur est survenue.';
  }
}
