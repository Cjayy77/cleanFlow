import { auth, db, storage, ROLE_PRESTATAIRE, loadUserDoc, loadPhotoDocs, uploadBookingImage, formatBookingStatus } from './shared.js';
import { collection, query, where, orderBy, onSnapshot, getDoc, updateDoc, doc, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import { ref, uploadBytes } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-storage.js';

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

const PHOTO_SLOTS = [
  { key: 'kitchen_before', label: 'Cuisine — avant' },
  { key: 'kitchen_after', label: 'Cuisine — après' },
  { key: 'bathroom', label: 'Salle de bain' },
  { key: 'bedroom1', label: 'Chambre 1' },
  { key: 'bedroom2', label: 'Chambre 2' },
  { key: 'linen', label: 'Linge changé' },
];

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

function setIncidentMessage(message = '', visible = false) {
  incidentStatus.textContent = message;
  incidentStatus.classList.toggle('hidden', !visible);
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

function buildBookingCard(booking, buttonText, action) {
  const wrapper = document.createElement('div');
  wrapper.className = 'task-card';
  wrapper.innerHTML = `
    <div class="task-top">
      <div>
        <div class="task-title">${booking.propertyAddress || booking.propertyId}</div>
        <div class="task-meta">${booking.scheduledDate} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}</div>
      </div>
      <div class="status-pill ${booking.status}">${formatBookingStatus(booking.status)}</div>
    </div>
    <div class="task-meta">${booking.price}€ · Réf ${booking.id.slice(0, 6).toUpperCase()}</div>
  `;
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
    const card = buildBookingCard(booking, 'Accepter', async () => {
      try {
        const bookingRef = doc(db, 'bookings', booking.id);
        await updateDoc(bookingRef, {
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
  heading.textContent = `Dossier ${activeBooking.id.slice(0, 6).toUpperCase()}`;
  const title = document.createElement('h2');
  title.textContent = activeBooking.propertyAddress || activeBooking.propertyId;
  const text = document.createElement('p');
  text.textContent = `Statut : ${formatBookingStatus(activeBooking.status)} — ${activeBooking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}`;
  activeBookingContainer.appendChild(heading);
  activeBookingContainer.appendChild(title);
  activeBookingContainer.appendChild(text);

  const photoGrid = document.createElement('div');
  photoGrid.className = 'photo-grid';
  PHOTO_SLOTS.forEach(slot => {
    const slotEl = document.createElement('div');
    slotEl.className = 'photo-slot' + (activePhotoRecords[slot.key] ? ' uploaded' : '');
    const isUploaded = !!activePhotoRecords[slot.key];
    slotEl.innerHTML = `<span>${slot.label}</span>`;
    if (isUploaded) {
      slotEl.innerHTML = `<img src="${activePhotoRecords[slot.key].downloadUrl || ''}" alt="${slot.label}">`;
    }
    slotEl.onclick = () => {
      if (activeBooking.status !== 'accepted') return;
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        await uploadBookingImage({ bookingId: activeBooking.id, slot: slot.key, file, uploadedBy: currentUser.uid });
        await loadPhotosForBooking(activeBooking.id);
        renderActiveBooking();
      };
      fileInput.click();
    };
    photoGrid.appendChild(slotEl);
  });
  activeBookingContainer.appendChild(photoGrid);

  const count = countUploadedPhotos();
  const button = document.createElement('button');
  button.className = 'btn gold';
  button.type = 'button';
  button.textContent = `Envoyer pour vérification (${count}/${PHOTO_SLOTS.length})`;
  button.disabled = activeBooking.status !== 'accepted' || count < PHOTO_SLOTS.length;
  button.onclick = async () => {
    try {
      const bookingRef = doc(db, 'bookings', activeBooking.id);
      await updateDoc(bookingRef, { status: 'submitted' });
    } catch (e) {
      setAuthMessage('Impossible d’envoyer le dossier.');
    }
  };
  activeBookingContainer.appendChild(button);
}

async function loadAssignedBookings() {
  if (assignedUnsub) assignedUnsub();
  const assignedQuery = query(collection(db, 'bookings'), where('prestataireId', '==', currentUser.uid), where('status', 'in', ['accepted', 'submitted']), orderBy('scheduledDate', 'asc'));
  assignedUnsub = onSnapshot(assignedQuery, async snapshot => {
    const bookings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    activeBooking = bookings[0] || null;
    if (activeBooking) {
      await loadPhotosForBooking(activeBooking.id);
    }
    renderActiveBooking();
  }, error => {
    setAuthMessage('Impossible de charger vos missions.');
  });
}

async function loadPendingBookings() {
  if (pendingUnsub) pendingUnsub();
  const pendingQuery = query(collection(db, 'bookings'), where('status', '==', 'pending'), orderBy('createdAt', 'asc'));
  pendingUnsub = onSnapshot(pendingQuery, snapshot => {
    pendingBookings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderPendingList();
  }, error => {
    setAuthMessage('Impossible de charger les missions disponibles.');
  });
}

async function ensurePrestataireRole(user) {
  const docData = await loadUserDoc(user.uid);
  if (!docData || docData.role !== ROLE_PRESTATAIRE) {
    throw new Error('Ce compte n’est pas autorisé sur l’interface prestataire.');
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
    const docData = await ensurePrestataireRole(user);
    currentUser = { uid: user.uid, ...docData };
    showApp();
    await loadPendingBookings();
    await loadAssignedBookings();
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
  activeBooking = null;
  pendingBookings = [];
  showAuth();
});

incidentForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!activeBooking) {
    setIncidentMessage('Sélectionnez d’abord une mission active.', true);
    return;
  }
  setIncidentMessage('', false);

  const type = incidentType.value;
  const description = incidentDescription.value.trim();
  const file = incidentPhoto.files[0];
  if (!description) {
    setIncidentMessage('Veuillez décrire l’incident.', true);
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
      await uploadBytes(incidentRef, file);
      incidentPayload.photoRefs = [incidentPath];
    }
    await addDoc(collection(db, 'incidents'), incidentPayload);
    incidentForm.reset();
    setIncidentMessage('Signalement envoyé. CleanFlow pourra le consulter dans l’admin.', true);
  } catch (err) {
    setIncidentMessage('Impossible d’envoyer le signalement.', true);
  }
});
