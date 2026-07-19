// Kleining — interface prestataire : missions disponibles, photos, incidents.
import {
  auth,
  db,
  storage,
  ROLE_PRESTATAIRE,
  PHOTO_SLOTS,
  loadUserDoc,
  loadPhotoDocs,
  uploadBookingImage,
  formatShortDate,
  formatBookingStatus,
  authErrorMessage,
} from './shared.js';
import {
  collection,
  query,
  where,
  onSnapshot,
  updateDoc,
  doc,
  addDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

const authScreen = document.getElementById('authScreen');
const appScreen = document.getElementById('appScreen');
const authError = document.getElementById('authError');
const signInForm = document.getElementById('signInForm');
const signOutBtn = document.getElementById('signOutBtn');
const userNameLabel = document.getElementById('userNameLabel');
const pendingList = document.getElementById('pendingList');
const activeBookingContainer = document.getElementById('activeBooking');
const incidentForm = document.getElementById('incidentForm');
const incidentStatus = document.getElementById('incidentStatus');
const incidentType = document.getElementById('incidentType');
const incidentDescription = document.getElementById('incidentDescription');
const incidentPhoto = document.getElementById('incidentPhoto');

// Statuts sur lesquels le prestataire peut encore agir ('rejected' = dossier
// renvoyé par l'admin pour correction, à re-soumettre).
const ACTIONABLE_STATUSES = ['accepted', 'submitted', 'rejected'];

let currentUser = null;
let pendingBookings = [];
let activeBooking = null;
let activePhotoRecords = {};
let pendingUnsub = null;
let assignedUnsub = null;

function setAuthMessage(message) {
  authError.textContent = message;
  authError.classList.toggle('hidden', !message);
}

function setIncidentMessage(message = '') {
  incidentStatus.textContent = message;
  incidentStatus.classList.toggle('hidden', !message);
}

function showAuth(message = '') {
  authScreen.classList.remove('hidden');
  appScreen.classList.add('hidden');
  setAuthMessage(message);
}

function showApp() {
  authScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  setAuthMessage('');
  userNameLabel.textContent = currentUser.name || currentUser.email;
}

function buildBookingCard(booking, buttonText, action) {
  const wrapper = document.createElement('div');
  wrapper.className = 'task-card';
  wrapper.innerHTML = `
    <div class="task-top">
      <div>
        <div class="task-title"></div>
        <div class="task-meta">${formatShortDate(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}${booking.linenRequested ? ' · + linge' : ''}</div>
      </div>
      <div class="status-pill ${booking.status}">${formatBookingStatus(booking.status)}</div>
    </div>
    <div class="task-meta">${booking.price}€ · Réf ${booking.id.slice(0, 6).toUpperCase()}</div>
  `;
  wrapper.querySelector('.task-title').textContent = booking.propertyAddress || booking.propertyId;
  if (buttonText) {
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.type = 'button';
    btn.textContent = buttonText;
    btn.onclick = action;
    wrapper.appendChild(btn);
  }
  return wrapper;
}

async function loadPhotosForBooking(bookingId) {
  const photoDocs = await loadPhotoDocs(bookingId);
  activePhotoRecords = photoDocs.reduce((acc, photo) => ({ ...acc, [photo.slot]: photo }), {});
}

function countUploadedPhotos() {
  return PHOTO_SLOTS.filter(slot => activePhotoRecords[slot.key]).length;
}

function renderPendingList() {
  pendingList.innerHTML = '';
  if (pendingBookings.length === 0) {
    pendingList.innerHTML = '<div class="empty-state">Aucune nouvelle mission disponible.</div>';
    return;
  }
  pendingBookings.forEach(booking => {
    const card = buildBookingCard(booking, 'Accepter la mission', async () => {
      try {
        await updateDoc(doc(db, 'bookings', booking.id), {
          prestataireId: currentUser.uid,
          status: 'accepted',
        });
      } catch (e) {
        setAuthMessage('Impossible d’accepter la mission.');
      }
    });
    pendingList.appendChild(card);
  });
}

function renderActiveBooking() {
  activeBookingContainer.innerHTML = '';
  if (!activeBooking) {
    activeBookingContainer.innerHTML = '<div class="empty-state">Aucune mission en cours.</div>';
    return;
  }
  const heading = document.createElement('div');
  heading.className = 'eyebrow';
  heading.textContent = `Dossier ${activeBooking.id.slice(0, 6).toUpperCase()} · ${formatBookingStatus(activeBooking.status)}`;
  const title = document.createElement('h2');
  title.textContent = activeBooking.propertyAddress || activeBooking.propertyId;
  const text = document.createElement('p');
  text.textContent = `${formatShortDate(activeBooking.scheduledDate)} — ${activeBooking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}${activeBooking.linenRequested ? ' · linge à changer' : ''}`;
  activeBookingContainer.appendChild(heading);
  activeBookingContainer.appendChild(title);
  activeBookingContainer.appendChild(text);

  if (activeBooking.status === 'rejected' && activeBooking.adminNote) {
    const note = document.createElement('div');
    note.className = 'status-banner';
    note.textContent = `Dossier renvoyé par Kleining : ${activeBooking.adminNote}`;
    activeBookingContainer.appendChild(note);
  }

  const canUpload = ['accepted', 'rejected'].includes(activeBooking.status);
  const photoGrid = document.createElement('div');
  photoGrid.className = 'photo-grid';
  PHOTO_SLOTS.forEach(slot => {
    const record = activePhotoRecords[slot.key];
    const slotEl = document.createElement('div');
    slotEl.className = 'photo-slot' + (record ? ' uploaded' : '');
    if (record) {
      const img = document.createElement('img');
      img.src = record.downloadUrl || '';
      img.alt = slot.label;
      slotEl.appendChild(img);
    } else {
      const span = document.createElement('span');
      span.textContent = slot.label;
      slotEl.appendChild(span);
    }
    if (canUpload) {
      slotEl.onclick = () => {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.onchange = async event => {
          const file = event.target.files[0];
          if (!file) return;
          try {
            await uploadBookingImage({ bookingId: activeBooking.id, slot: slot.key, file, uploadedBy: currentUser.uid });
            await loadPhotosForBooking(activeBooking.id);
            renderActiveBooking();
          } catch (e) {
            setAuthMessage('Impossible de téléverser la photo.');
          }
        };
        fileInput.click();
      };
    }
    photoGrid.appendChild(slotEl);
  });
  activeBookingContainer.appendChild(photoGrid);

  const count = countUploadedPhotos();
  const button = document.createElement('button');
  button.className = 'btn gold';
  button.type = 'button';
  button.textContent = activeBooking.status === 'submitted'
    ? 'Dossier envoyé — en attente de vérification Kleining'
    : `Envoyer pour vérification (${count}/${PHOTO_SLOTS.length})`;
  button.disabled = !canUpload || count < PHOTO_SLOTS.length;
  button.onclick = async () => {
    try {
      await updateDoc(doc(db, 'bookings', activeBooking.id), { status: 'submitted' });
    } catch (e) {
      setAuthMessage('Impossible d’envoyer le dossier.');
    }
  };
  activeBookingContainer.appendChild(button);
}

function loadAssignedBookings() {
  if (assignedUnsub) assignedUnsub();
  // Filtre unique + tri côté client : aucun index composite à créer.
  const assignedQuery = query(collection(db, 'bookings'), where('prestataireId', '==', currentUser.uid));
  assignedUnsub = onSnapshot(assignedQuery, async snapshot => {
    const actionable = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .filter(booking => ACTIONABLE_STATUSES.includes(booking.status))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
    activeBooking = actionable[0] || null;
    if (activeBooking) {
      await loadPhotosForBooking(activeBooking.id);
    } else {
      activePhotoRecords = {};
    }
    renderActiveBooking();
  }, () => setAuthMessage('Impossible de charger vos missions.'));
}

function loadPendingBookings() {
  if (pendingUnsub) pendingUnsub();
  const pendingQuery = query(collection(db, 'bookings'), where('status', '==', 'pending'));
  pendingUnsub = onSnapshot(pendingQuery, snapshot => {
    pendingBookings = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
    renderPendingList();
  }, () => setAuthMessage('Impossible de charger les missions disponibles.'));
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    if (pendingUnsub) pendingUnsub();
    if (assignedUnsub) assignedUnsub();
    showAuth();
    return;
  }
  try {
    const docData = await loadUserDoc(user.uid);
    if (!docData || docData.role !== ROLE_PRESTATAIRE) {
      await signOut(auth);
      showAuth('Ce compte n’est pas autorisé sur l’interface prestataire.');
      return;
    }
    currentUser = { uid: user.uid, ...docData };
    showApp();
    loadPendingBookings();
    loadAssignedBookings();
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
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    setAuthMessage(authErrorMessage(err));
  }
});

signOutBtn.addEventListener('click', async () => {
  await signOut(auth);
  activeBooking = null;
  pendingBookings = [];
  activePhotoRecords = {};
});

incidentForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!activeBooking) {
    setIncidentMessage('Aucune mission active à laquelle rattacher le signalement.');
    return;
  }
  const type = incidentType.value;
  const description = incidentDescription.value.trim();
  const file = incidentPhoto.files[0];
  if (!description) {
    setIncidentMessage('Veuillez décrire l’incident.');
    return;
  }

  const incidentPayload = {
    bookingId: activeBooking.id,
    reportedBy: currentUser.uid,
    type,
    description,
    reportedAt: serverTimestamp(),
    status: 'open',
  };

  try {
    if (file) {
      const incidentPath = `incidents/${activeBooking.id}/${Date.now()}_${file.name}`;
      const incidentRef = ref(storage, incidentPath);
      await uploadBytes(incidentRef, file, { contentType: file.type || 'image/jpeg' });
      incidentPayload.photoRefs = [await getDownloadURL(incidentRef)];
    }
    await addDoc(collection(db, 'incidents'), incidentPayload);
    incidentForm.reset();
    setIncidentMessage('Signalement envoyé à l’équipe Kleining.');
  } catch (err) {
    setIncidentMessage('Impossible d’envoyer le signalement.');
  }
});
