import { auth, db, ROLE_ADMIN, loadUserDoc, loadPhotoDocs, loadIncidentDocs, formatBookingStatus } from './shared.js';
import { collection, query, where, orderBy, onSnapshot, updateDoc, doc, getDoc } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

const authScreen = document.getElementById('authScreen');
const appScreen = document.getElementById('appScreen');
const authError = document.getElementById('authError');
const signInForm = document.getElementById('signInForm');
const signOutBtn = document.getElementById('signOutBtn');
const userNameLabel = document.getElementById('userNameLabel');
const bookingQueue = document.getElementById('bookingQueue');
const bookingTitle = document.getElementById('bookingTitle');
const bookingMeta = document.getElementById('bookingMeta');
const photoGrid = document.getElementById('photoGrid');
const verifyBtn = document.getElementById('verifyBtn');
const rejectBtn = document.getElementById('rejectBtn');
const rejectNoteContainer = document.getElementById('rejectNoteContainer');
const rejectNote = document.getElementById('rejectNote');
const incidentList = document.getElementById('incidentList');
const adminStatus = document.getElementById('adminStatus');

const PHOTO_SLOTS = [
  { key: 'kitchen_before', label: 'Cuisine — avant' },
  { key: 'kitchen_after', label: 'Cuisine — après' },
  { key: 'bathroom', label: 'Salle de bain' },
  { key: 'bedroom1', label: 'Chambre 1' },
  { key: 'bedroom2', label: 'Chambre 2' },
  { key: 'linen', label: 'Linge changé' },
];

let currentUser = null;
let selectedBooking = null;
let bookingQueueData = [];
let bookingQueueUnsub = null;

function setAuthMessage(message) {
  authError.textContent = message;
  authError.classList.toggle('hidden', !message);
}

function setAdminStatus(message = '', visible = false) {
  adminStatus.textContent = message;
  adminStatus.classList.toggle('hidden', !visible);
}

function showAuth() {
  authScreen.style.display = 'block';
  appScreen.style.display = 'none';
  setAuthMessage('');
}

function showApp() {
  authScreen.style.display = 'none';
  appScreen.style.display = 'block';
  setAuthMessage('');
  userNameLabel.textContent = currentUser.name || currentUser.email;
}

function buildBookingQueueItem(booking) {
  const item = document.createElement('div');
  item.className = 'task-card' + (selectedBooking && selectedBooking.id === booking.id ? ' active' : '');
  item.innerHTML = `
    <div class="task-top">
      <div>
        <div class="task-title">${booking.propertyAddress || booking.propertyId}</div>
        <div class="task-meta">${booking.scheduledDate} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}</div>
      </div>
      <div class="status-pill submitted">${formatBookingStatus('submitted')}</div>
    </div>
    <div class="task-meta">${booking.price}€ · ${booking.clientEmail || ''}</div>
  `;
  item.onclick = async () => {
    selectedBooking = booking;
    await refreshBookingDetail();
    renderBookingQueue();
  };
  return item;
}

async function renderBookingQueue() {
  bookingQueue.innerHTML = '';
  if (bookingQueueData.length === 0) {
    bookingQueue.innerHTML = '<div class="empty-state">Aucun dossier en attente de vérification.</div>';
    return;
  }
  bookingQueueData.forEach(booking => bookingQueue.appendChild(buildBookingQueueItem(booking)));
}

function renderBookingDetail() {
  if (!selectedBooking) {
    bookingTitle.textContent = 'Aucun dossier sélectionné';
    bookingMeta.textContent = '';
    photoGrid.innerHTML = '';
    verifyBtn.disabled = true;
    rejectBtn.disabled = true;
    rejectNoteContainer.classList.add('hidden');
    incidentList.innerHTML = '';
    return;
  }

  bookingTitle.textContent = selectedBooking.propertyAddress || selectedBooking.propertyId;
  bookingMeta.textContent = `${selectedBooking.clientEmail || ''} · ${selectedBooking.scheduledDate} · ${selectedBooking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}`;
  photoGrid.innerHTML = '';

  PHOTO_SLOTS.forEach(slot => {
    const photo = selectedBooking.photos && selectedBooking.photos[slot.key];
    const slotEl = document.createElement('div');
    slotEl.className = 'photo-slot' + (photo ? ' uploaded' : '');
    slotEl.textContent = photo ? '' : slot.label;
    if (photo) {
      const img = document.createElement('img');
      img.src = photo.downloadUrl || '';
      img.alt = slot.label;
      slotEl.appendChild(img);
    }
    photoGrid.appendChild(slotEl);
  });

  const allUploaded = PHOTO_SLOTS.every(slot => selectedBooking.photos && selectedBooking.photos[slot.key]);
  verifyBtn.disabled = !selectedBooking || !allUploaded;
  rejectBtn.disabled = !selectedBooking;
  rejectNoteContainer.classList.toggle('hidden', false);

  renderIncidents();
}

async function refreshBookingDetail() {
  if (!selectedBooking) return;
  const bookingRef = doc(db, 'bookings', selectedBooking.id);
  const bookingSnap = await getDoc(bookingRef);
  if (!bookingSnap.exists()) return;
  selectedBooking = { id: bookingSnap.id, ...bookingSnap.data() };
  const photos = await loadPhotoDocs(selectedBooking.id);
  selectedBooking.photos = photos.reduce((acc, photo) => ({ ...acc, [photo.slot]: photo }), {});
}

async function renderIncidents() {
  incidentList.innerHTML = '';
  if (!selectedBooking) return;
  const incidents = await loadIncidentDocs(selectedBooking.id);
  if (incidents.length === 0) {
    incidentList.innerHTML = '<div class="empty-state">Aucun incident signalé pour ce dossier.</div>';
    return;
  }
  incidents.forEach(incident => {
    const item = document.createElement('div');
    item.className = 'incident-item';
    item.innerHTML = `
      <div><strong>${incident.type === 'broken_object' ? 'Objet cassé' : incident.type === 'lost_object' ? 'Objet perdu' : 'Autre'}</strong></div>
      <div class="task-meta">${incident.description}</div>
      <div class="task-meta">Statut : ${incident.status}</div>
    `;
    incidentList.appendChild(item);
  });
}

async function refreshQueue() {
  const queueQuery = query(collection(db, 'bookings'), where('status', '==', 'submitted'), orderBy('scheduledDate', 'asc'));
  if (bookingQueueUnsub) bookingQueueUnsub();
  bookingQueueUnsub = onSnapshot(queueQuery, async snapshot => {
    bookingQueueData = [];
    for (const docSnap of snapshot.docs) {
      const data = { id: docSnap.id, ...docSnap.data() };
      const clientSnap = await getDoc(doc(db, 'users', data.clientId));
      data.clientEmail = clientSnap.exists() ? clientSnap.data().email : '';
      const propertySnap = await getDoc(doc(db, 'properties', data.propertyId));
      data.propertyAddress = propertySnap.exists() ? `${propertySnap.data().street}, ${propertySnap.data().city}` : data.propertyId;
      bookingQueueData.push(data);
    }
    if (selectedBooking) {
      const stillExists = bookingQueueData.find(b => b.id === selectedBooking.id);
      if (stillExists) {
        selectedBooking = stillExists;
        await refreshBookingDetail();
      } else {
        selectedBooking = null;
      }
    }
    renderBookingQueue();
    renderBookingDetail();
  }, error => {
    setAdminStatus('Impossible de charger la file de vérification.', true);
  });
}

async function ensureAdminRole(user) {
  const docData = await loadUserDoc(user.uid);
  if (!docData || docData.role !== ROLE_ADMIN) {
    throw new Error('Ce compte n’est pas autorisé sur l’interface admin.');
  }
  return docData;
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    showAuth();
    return;
  }
  try {
    const docData = await ensureAdminRole(user);
    currentUser = { uid: user.uid, ...docData };
    showApp();
    await refreshQueue();
  } catch (error) {
    setAuthMessage(error.message);
    await signOut(auth);
    showAuth();
  }
});

signInForm.addEventListener('submit', async event => {
  event.preventDefault();
  setAuthMessage('');
  const email = document.getElementById('signInEmail').value.trim();
  const password = document.getElementById('signInPassword').value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    setAuthMessage(err.message);
  }
});

signOutBtn.addEventListener('click', async () => {
  await signOut(auth);
  currentUser = null;
  selectedBooking = null;
  if (bookingQueueUnsub) bookingQueueUnsub();
  showAuth();
});

verifyBtn.addEventListener('click', async () => {
  if (!selectedBooking) return;
  try {
    const bookingRef = doc(db, 'bookings', selectedBooking.id);
    await updateDoc(bookingRef, { status: 'verified' });
    if (rejectNote.value.trim()) {
      await updateDoc(bookingRef, { adminNote: rejectNote.value.trim() });
    }
    setAdminStatus('Dossier validé et le client sera notifié après la vérification.', true);
  } catch (err) {
    setAdminStatus('Impossible de vérifier le dossier.', true);
  }
});

rejectBtn.addEventListener('click', async () => {
  if (!selectedBooking) return;
  try {
    const bookingRef = doc(db, 'bookings', selectedBooking.id);
    await updateDoc(bookingRef, { status: 'rejected' });
    if (rejectNote.value.trim()) {
      await updateDoc(bookingRef, { adminNote: rejectNote.value.trim() });
    }
    setAdminStatus('Dossier renvoyé au prestataire pour correction.', true);
  } catch (err) {
    setAdminStatus('Impossible de rejeter le dossier.', true);
  }
});
