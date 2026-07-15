const STORAGE_KEY = 'kleining_local_store';
const AUTH_KEY = 'kleining_local_auth';

export const ROLE_CLIENT = 'client';
export const ROLE_PRESTATAIRE = 'prestataire';
export const ROLE_LIVREUR = 'livreur';
export const ROLE_ADMIN = 'admin';

const localAuthCallbacks = [];

function randomId(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function loadStore() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const store = createSeedStore();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return store;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const store = createSeedStore();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return store;
  }
}

function saveStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function getStore() {
  return loadStore();
}

function createSeedStore() {
  const clientId = 'client_001';
  const prestataireId = 'prestataire_001';
  const livreurId = 'livreur_001';
  const adminId = 'admin_001';
  const propertyId = 'property_001';
  const pendingBookingId = 'booking_001';
  const submittedBookingId = 'booking_002';
  const linenBookingId = 'booking_003';

  return {
    users: {
      [clientId]: { id: clientId, email: 'client@kleining.test', password: 'client123', role: ROLE_CLIENT, name: 'Claire Martin', phone: '06 12 34 56 78' },
      [prestataireId]: { id: prestataireId, email: 'prestataire@kleining.test', password: 'partner123', role: ROLE_PRESTATAIRE, name: 'Nettoyage Paris', phone: '06 98 76 54 32' },
      [livreurId]: { id: livreurId, email: 'livreur@kleining.test', password: 'livreur123', role: ROLE_LIVREUR, name: 'Dépôt Linge', phone: '06 77 88 99 00' },
      [adminId]: { id: adminId, email: 'admin@kleining.test', password: 'admin123', role: ROLE_ADMIN, name: 'Équipe Kleining', phone: '06 00 11 22 33' },
    },
    properties: {
      [propertyId]: {
        id: propertyId,
        ownerId: clientId,
        street: '16 rue de la Pompe',
        city: 'Paris',
        postalCode: '75116',
        notes: 'Arrivée après 15h. Ne pas sonner.',
        createdAt: nowIso(),
      },
    },
    bookings: {
      [pendingBookingId]: {
        id: pendingBookingId,
        propertyId,
        clientId,
        prestataireId: null,
        serviceType: 'normal',
        price: 47,
        scheduledDate: getDateOffset(5),
        status: 'pending',
        linenRequested: false,
        createdAt: nowIso(),
      },
      [submittedBookingId]: {
        id: submittedBookingId,
        propertyId,
        clientId,
        prestataireId,
        serviceType: 'deep',
        price: 60,
        scheduledDate: getDateOffset(2),
        status: 'submitted',
        linenRequested: true,
        createdAt: nowIso(),
      },
      [linenBookingId]: {
        id: linenBookingId,
        propertyId,
        clientId,
        prestataireId: prestataireId,
        serviceType: 'normal',
        price: 47,
        scheduledDate: getDateOffset(8),
        status: 'accepted',
        linenRequested: true,
        createdAt: nowIso(),
      },
    },
    photos: {
      [`${submittedBookingId}_kitchen_before`]: {
        id: `${submittedBookingId}_kitchen_before`,
        bookingId: submittedBookingId,
        slot: 'kitchen_before',
        uploadedBy: prestataireId,
        downloadUrl: 'https://placehold.co/320x240?text=Cuisine+avant',
        uploadedAt: nowIso(),
        verified: false,
      },
      [`${submittedBookingId}_kitchen_after`]: {
        id: `${submittedBookingId}_kitchen_after`,
        bookingId: submittedBookingId,
        slot: 'kitchen_after',
        uploadedBy: prestataireId,
        downloadUrl: 'https://placehold.co/320x240?text=Cuisine+après',
        uploadedAt: nowIso(),
        verified: false,
      },
    },
    incidents: {
      incident_001: {
        id: 'incident_001',
        bookingId: submittedBookingId,
        reportedBy: prestataireId,
        type: 'broken_object',
        description: 'Petit vase cassé dans le séjour, j’ai pris une photo.',
        photoRef: null,
        reportedAt: nowIso(),
        status: 'pending',
      },
    },
  };
}

function getDateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function notifyAuthState(user) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(user || null));
  localAuthCallbacks.forEach(callback => callback(user));
}

export function onAuthStateChangedLocal(callback) {
  if (typeof callback !== 'function') return;
  localAuthCallbacks.push(callback);
  callback(getCurrentAuthUser());
}

export function getCurrentAuthUser() {
  const raw = localStorage.getItem(AUTH_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function signInLocal(email, password) {
  const store = getStore();
  const user = Object.values(store.users).find(user => user.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    throw new Error('Aucun compte trouvé pour cette adresse.');
  }
  if (user.password !== password) {
    throw new Error('Mot de passe incorrect.');
  }
  notifyAuthState(user);
  return user;
}

export function signInWithGoogleLocal(role) {
  const store = getStore();
  const user = Object.values(store.users).find(user => user.role === role);
  if (!user) {
    throw new Error('Compte Google de rôle introuvable.');
  }
  notifyAuthState(user);
  return user;
}

export function createUserLocal({ name, email, password, phone, role }) {
  const store = getStore();
  if (Object.values(store.users).some(user => user.email.toLowerCase() === email.toLowerCase())) {
    throw new Error('Un compte avec cette adresse existe déjà.');
  }
  const id = randomId('user');
  const user = {
    id,
    name,
    email,
    password,
    phone,
    role,
    createdAt: nowIso(),
  };
  store.users[id] = user;
  saveStore(store);
  notifyAuthState(user);
  return user;
}

export function signOutLocal() {
  notifyAuthState(null);
}

export function loadUserDoc(uid) {
  const store = getStore();
  return store.users[uid] || null;
}

export function getPropertiesByOwner(ownerId) {
  const store = getStore();
  return Object.values(store.properties)
    .filter(property => property.ownerId === ownerId)
    .sort((a, b) => a.street.localeCompare(b.street));
}

export function addProperty({ ownerId, street, city, postalCode, notes }) {
  const store = getStore();
  const id = randomId('property');
  store.properties[id] = {
    id,
    ownerId,
    street,
    city,
    postalCode,
    notes,
    createdAt: nowIso(),
  };
  saveStore(store);
  return store.properties[id];
}

export function getBookingsByClient(clientId) {
  const store = getStore();
  return Object.values(store.bookings)
    .filter(booking => booking.clientId === clientId)
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
}

export function getBookingsByStatus(statuses) {
  const store = getStore();
  return Object.values(store.bookings)
    .filter(booking => statuses.includes(booking.status))
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
}

export function getBookingsForPrestataire(prestataireId) {
  const store = getStore();
  return Object.values(store.bookings)
    .filter(booking => booking.prestataireId === prestataireId && ['accepted', 'submitted'].includes(booking.status))
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
}

export function getPendingBookings() {
  return getBookingsByStatus(['pending']);
}

export function getLaundryTasks() {
  const store = getStore();
  return Object.values(store.bookings)
    .filter(booking => booking.linenRequested && ['pending', 'accepted', 'submitted', 'verified'].includes(booking.status))
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
}

export function addBooking({ propertyId, clientId, serviceType, price, scheduledDate, linenRequested }) {
  const store = getStore();
  const id = randomId('booking');
  store.bookings[id] = {
    id,
    propertyId,
    clientId,
    prestataireId: null,
    serviceType,
    price,
    scheduledDate,
    status: 'pending',
    linenRequested: !!linenRequested,
    createdAt: nowIso(),
  };
  saveStore(store);
  return store.bookings[id];
}

export function acceptBooking(bookingId, prestataireId) {
  const store = getStore();
  const booking = store.bookings[bookingId];
  if (!booking) throw new Error('Réservation introuvable.');
  booking.prestataireId = prestataireId;
  booking.status = 'accepted';
  saveStore(store);
  return booking;
}

export function submitBooking(bookingId) {
  const store = getStore();
  const booking = store.bookings[bookingId];
  if (!booking) throw new Error('Réservation introuvable.');
  booking.status = 'submitted';
  saveStore(store);
  return booking;
}

export function updateBookingStatus(bookingId, status, adminNote = '') {
  const store = getStore();
  const booking = store.bookings[bookingId];
  if (!booking) throw new Error('Réservation introuvable.');
  booking.status = status;
  if (adminNote) booking.adminNote = adminNote;
  saveStore(store);
  return booking;
}

export function getBookingById(bookingId) {
  const store = getStore();
  return store.bookings[bookingId] || null;
}

export async function uploadBookingImage({ bookingId, slot, file, uploadedBy }) {
  const store = getStore();
  const reader = new FileReader();
  const dataUrl = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const normalizedSlot = slot.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const id = `${bookingId}_${normalizedSlot}`;
  store.photos[id] = {
    id,
    bookingId,
    uploadedBy,
    slot: normalizedSlot,
    downloadUrl: dataUrl,
    uploadedAt: nowIso(),
    verified: false,
  };
  saveStore(store);
  return store.photos[id];
}

export function getPhotosByBooking(bookingId) {
  const store = getStore();
  return Object.values(store.photos).filter(photo => photo.bookingId === bookingId);
}

export function addIncident({ bookingId, reportedBy, type, description, photoUrl = null }) {
  const store = getStore();
  const id = randomId('incident');
  store.incidents[id] = {
    id,
    bookingId,
    reportedBy,
    type,
    description,
    photoRef: photoUrl,
    reportedAt: nowIso(),
    status: 'pending',
  };
  saveStore(store);
  return store.incidents[id];
}

export function getIncidentsByBooking(bookingId) {
  const store = getStore();
  return Object.values(store.incidents)
    .filter(incident => incident.bookingId === bookingId)
    .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
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
    case 'rejected': return 'Rejeté';
    default: return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export function formatPrice(serviceType) {
  return serviceType === 'deep' ? 60 : 47;
}
