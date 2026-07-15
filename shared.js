import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  getDocs
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export const ROLE_CLIENT = 'client';
export const ROLE_PRESTATAIRE = 'prestataire';
export const ROLE_LIVREUR = 'livreur';
export const ROLE_ADMIN = 'admin';

export async function createOrUpdateUserDoc(user, role, details = {}) {
  const userRef = doc(db, 'users', user.uid);
  const snapshot = await getDoc(userRef);
  const payload = {
    uid: user.uid,
    role,
    email: user.email || '',
    name: details.name || '',
    phone: details.phone || '',
    updatedAt: serverTimestamp(),
  };

  if (!snapshot.exists()) {
    await setDoc(userRef, {
      ...payload,
      createdAt: serverTimestamp(),
    });
    return { ...payload, createdAt: new Date().toISOString() };
  }

  const existing = snapshot.data();
  if (existing.role !== role) {
    return existing;
  }

  await updateDoc(userRef, payload);
  return { ...existing, ...payload };
}

export async function loadUserDoc(uid) {
  if (!uid) return null;
  const snapshot = await getDoc(doc(db, 'users', uid));
  return snapshot.exists() ? snapshot.data() : null;
}

export async function uploadBookingImage({ bookingId, slot, file, uploadedBy }) {
  const normalizedSlot = slot.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const storagePath = `bookings/${bookingId}/${normalizedSlot}.jpg`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, file);
  const downloadUrl = await getDownloadURL(storageRef);
  const photoRef = doc(db, 'photos', `${bookingId}_${normalizedSlot}`);
  await setDoc(photoRef, {
    bookingId,
    uploadedBy,
    storagePath,
    downloadUrl,
    slot: normalizedSlot,
    uploadedAt: serverTimestamp(),
    verified: false,
  });
  return { storagePath, downloadUrl };
}

export function formatShortDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('fr-FR', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

export function formatBookingStatus(status) {
  switch (status) {
    case 'pending': return 'En attente';
    case 'accepted': return 'Accepté';
    case 'submitted': return 'Photos soumises';
    case 'verified': return 'Confirmé';
    case 'rejected': return 'Rejeté';
    default: return status;
  }
}

export function formatPrice(serviceType) {
  return serviceType === 'deep' ? 60 : 47;
}

export async function loadPhotoDocs(bookingId) {
  const q = query(collection(db, 'photos'), where('bookingId', '==', bookingId));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function loadIncidentDocs(bookingId) {
  const q = query(collection(db, 'incidents'), where('bookingId', '==', bookingId), orderBy('reportedAt', 'desc'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}
