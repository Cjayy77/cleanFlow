// Kleining — interface admin : file de vérification des dossiers photo.
// Rien ne s'approuve automatiquement : chaque dossier passe par un humain ici.
import {
  auth,
  db,
  ROLE_ADMIN,
  PHOTO_SLOTS,
  loadUserDoc,
  loadPhotoDocs,
  loadIncidentDocs,
  formatShortDate,
  formatBookingStatus,
  authErrorMessage,
  withButtonLoading,
} from './shared.js';
import {
  collection,
  query,
  where,
  onSnapshot,
  updateDoc,
  doc,
  getDoc,
  writeBatch,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const loadingScreen = document.getElementById('loadingScreen');
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
const rejectNote = document.getElementById('rejectNote');
const incidentList = document.getElementById('incidentList');
const adminStatus = document.getElementById('adminStatus');

let currentUser = null;
let selectedBooking = null;
let bookingQueueData = [];
let bookingQueueUnsub = null;

function setAuthMessage(message) {
  authError.textContent = message;
  authError.classList.toggle('hidden', !message);
}

function setAdminStatus(message = '') {
  adminStatus.textContent = message;
  adminStatus.classList.toggle('hidden', !message);
}

function showAuth(message = '') {
  loadingScreen.classList.add('hidden');
  signOutBtn.classList.add('hidden');
  authScreen.classList.remove('hidden');
  appScreen.classList.add('hidden');
  setAuthMessage(message);
}

function showApp() {
  loadingScreen.classList.add('hidden');
  signOutBtn.classList.remove('hidden');
  authScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  setAuthMessage('');
  userNameLabel.textContent = currentUser.name || currentUser.email;
}

function buildBookingQueueItem(booking) {
  const item = document.createElement('div');
  item.className = 'task-card selectable' + (selectedBooking && selectedBooking.id === booking.id ? ' active' : '');
  item.innerHTML = `
    <div class="task-top">
      <div>
        <div class="task-title"></div>
        <div class="task-meta">${formatShortDate(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}</div>
      </div>
      <div class="status-pill submitted">${formatBookingStatus('submitted')}</div>
    </div>
    <div class="task-meta">${booking.price}€ · ${booking.clientEmail || ''}</div>
  `;
  item.querySelector('.task-title').textContent = booking.propertyAddress || booking.propertyId;
  item.onclick = async () => {
    selectedBooking = booking;
    await refreshBookingDetail();
    renderBookingQueue();
    renderBookingDetail();
  };
  return item;
}

function renderBookingQueue() {
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
    bookingMeta.textContent = 'Sélectionnez un dossier dans la file pour contrôler les photos.';
    photoGrid.innerHTML = '';
    incidentList.innerHTML = '';
    verifyBtn.disabled = true;
    rejectBtn.disabled = true;
    return;
  }

  bookingTitle.textContent = selectedBooking.propertyAddress || selectedBooking.propertyId;
  bookingMeta.textContent = `${selectedBooking.clientEmail || ''} · ${formatShortDate(selectedBooking.scheduledDate)} · ${selectedBooking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}${selectedBooking.linenRequested ? ' · + linge' : ''}`;
  photoGrid.innerHTML = '';

  PHOTO_SLOTS.forEach(slot => {
    const photo = selectedBooking.photos && selectedBooking.photos[slot.key];
    const slotEl = document.createElement('div');
    slotEl.className = 'photo-slot' + (photo ? ' uploaded' : '');
    if (photo) {
      const img = document.createElement('img');
      img.src = photo.downloadUrl || '';
      img.alt = slot.label;
      slotEl.appendChild(img);
      const link = document.createElement('a');
      link.href = photo.downloadUrl || '#';
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'photo-caption';
      link.textContent = slot.label;
      slotEl.appendChild(link);
    } else {
      const span = document.createElement('span');
      span.textContent = `${slot.label} — manquante`;
      slotEl.appendChild(span);
    }
    photoGrid.appendChild(slotEl);
  });

  const allUploaded = PHOTO_SLOTS.every(slot => selectedBooking.photos && selectedBooking.photos[slot.key]);
  verifyBtn.disabled = !allUploaded;
  rejectBtn.disabled = false;

  renderIncidents();
}

async function refreshBookingDetail() {
  if (!selectedBooking) return;
  const bookingSnap = await getDoc(doc(db, 'bookings', selectedBooking.id));
  if (!bookingSnap.exists()) return;
  const clientEmail = selectedBooking.clientEmail;
  selectedBooking = { id: bookingSnap.id, clientEmail, ...bookingSnap.data() };
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
    const typeLabel = incident.type === 'broken_object' ? 'Objet cassé' : incident.type === 'lost_object' ? 'Objet perdu' : 'Autre';
    const title = document.createElement('strong');
    title.textContent = typeLabel;
    const description = document.createElement('div');
    description.className = 'task-meta';
    description.textContent = incident.description;
    item.appendChild(title);
    item.appendChild(description);
    (incident.photoRefs || []).forEach((url, index) => {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'task-meta';
      link.textContent = `Photo jointe ${index + 1}`;
      item.appendChild(link);
    });
    incidentList.appendChild(item);
  });
}

function refreshQueue() {
  if (bookingQueueUnsub) bookingQueueUnsub();
  // Filtre unique + tri côté client : aucun index composite à créer.
  const queueQuery = query(collection(db, 'bookings'), where('status', '==', 'submitted'));
  bookingQueueUnsub = onSnapshot(queueQuery, async snapshot => {
    const rows = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
    for (const row of rows) {
      try {
        const clientSnap = await getDoc(doc(db, 'users', row.clientId));
        row.clientEmail = clientSnap.exists() ? clientSnap.data().email : '';
      } catch (e) {
        row.clientEmail = '';
      }
    }
    bookingQueueData = rows;
    if (selectedBooking) {
      const stillThere = bookingQueueData.find(b => b.id === selectedBooking.id);
      if (stillThere) {
        selectedBooking = stillThere;
        await refreshBookingDetail();
      } else {
        selectedBooking = null;
      }
    }
    renderBookingQueue();
    renderBookingDetail();
  }, () => setAdminStatus('Impossible de charger la file de vérification.'));
}

async function resolveBooking(status) {
  if (!selectedBooking) return;
  const note = rejectNote.value.trim();
  if (status === 'rejected' && !note) {
    setAdminStatus('Ajoutez une note avant de renvoyer le dossier : le prestataire doit savoir quoi corriger.');
    rejectNote.focus();
    return;
  }
  const update = { status };
  if (note) update.adminNote = note;
  if (status === 'verified') {
    update.verifiedBy = currentUser.uid;
    update.verifiedAt = serverTimestamp();
  }
  const actionBtn = status === 'verified' ? verifyBtn : rejectBtn;
  actionBtn.classList.add('loading');
  try {
    await updateDoc(doc(db, 'bookings', selectedBooking.id), update);
    if (status === 'verified' && selectedBooking.photos) {
      const batch = writeBatch(db);
      Object.values(selectedBooking.photos).forEach(photo => {
        batch.update(doc(db, 'photos', photo.id), {
          verified: true,
          verifiedBy: currentUser.uid,
          verifiedAt: serverTimestamp(),
        });
      });
      await batch.commit();
    }
    rejectNote.value = '';
    setAdminStatus(status === 'verified'
      ? 'Dossier validé — le client voit maintenant sa réservation confirmée.'
      : 'Dossier renvoyé au prestataire pour correction.');
  } catch (err) {
    setAdminStatus('Impossible de mettre à jour le dossier.');
  } finally {
    actionBtn.classList.remove('loading');
  }
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    if (bookingQueueUnsub) bookingQueueUnsub();
    showAuth();
    return;
  }
  try {
    const docData = await loadUserDoc(user.uid);
    if (!docData || docData.role !== ROLE_ADMIN) {
      await signOut(auth);
      showAuth('Ce compte n’est pas autorisé sur l’interface admin.');
      return;
    }
    currentUser = { uid: user.uid, ...docData };
    showApp();
    refreshQueue();
  } catch (error) {
    await signOut(auth);
    showAuth(authErrorMessage(error));
  }
});

signInForm.addEventListener('submit', async event => {
  event.preventDefault();
  setAuthMessage('');
  const email = document.getElementById('signInEmail').value.trim();
  const password = document.getElementById('signInPassword').value;
  try {
    await withButtonLoading(signInForm.querySelector('button[type="submit"]'),
      () => signInWithEmailAndPassword(auth, email, password));
  } catch (err) {
    setAuthMessage(authErrorMessage(err));
  }
});

signOutBtn.addEventListener('click', async () => {
  await signOut(auth);
  selectedBooking = null;
  bookingQueueData = [];
});

verifyBtn.addEventListener('click', () => resolveBooking('verified'));
rejectBtn.addEventListener('click', () => resolveBooking('rejected'));
