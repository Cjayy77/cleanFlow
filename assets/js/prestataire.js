// CleanFlow — interface prestataire : missions disponibles, photos, incidents.
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
  withButtonLoading,
  resetPassword,
  requestTeamAccess,
  queueEmail,
  TEAM_EMAIL,
  withTimeout,
  storageErrorMessage,
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

const loadingScreen = document.getElementById('loadingScreen');
const authScreen = document.getElementById('authScreen');
const appScreen = document.getElementById('appScreen');
const authError = document.getElementById('authError');
const signInForm = document.getElementById('signInForm');
const requestForm = document.getElementById('requestForm');
const switchToRequest = document.getElementById('switchToRequest');
const switchToSignIn = document.getElementById('switchToSignIn');
const signOutBtn = document.getElementById('signOutBtn');
const userNameLabel = document.getElementById('userNameLabel');
const assignedList = document.getElementById('assignedList');
const activeBookingContainer = document.getElementById('activeBooking');
const ratingSummary = document.getElementById('ratingSummary');
const ratingList = document.getElementById('ratingList');
const incidentForm = document.getElementById('incidentForm');
const incidentStatus = document.getElementById('incidentStatus');
const incidentType = document.getElementById('incidentType');
const incidentDescription = document.getElementById('incidentDescription');
const incidentPhoto = document.getElementById('incidentPhoto');
const workStatus = document.getElementById('workStatus');

function setWorkStatus(message, type = 'error') {
  workStatus.textContent = message;
  workStatus.className = `status-banner ${type}` + (message ? '' : ' hidden');
  if (message) workStatus.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Statuts sur lesquels le prestataire peut encore agir ('rejected' = dossier
// renvoyé par l'admin pour correction, à re-soumettre).
const ACTIONABLE_STATUSES = ['accepted', 'submitted', 'rejected'];

let currentUser = null;
let authNotice = null;
let assignedBookings = [];
let ratedBookings = [];
let selectedMissionId = null;
let activeBooking = null;
let activePhotoRecords = {};
let assignedUnsub = null;

function setAuthMessage(message, type = '') {
  authError.textContent = message;
  authError.className = 'status-banner' + (type ? ` ${type}` : '') + (message ? '' : ' hidden');
}

function setIncidentMessage(message = '', type = 'info') {
  incidentStatus.textContent = message;
  incidentStatus.className = `status-banner ${type}` + (message ? '' : ' hidden');
}

function showAuth(message = '', type = '') {
  loadingScreen.classList.add('hidden');
  signOutBtn.classList.add('hidden');
  authScreen.classList.remove('hidden');
  appScreen.classList.add('hidden');
  requestForm.classList.add('hidden');
  signInForm.classList.remove('hidden');
  setAuthMessage(message, type);
}

function showApp() {
  loadingScreen.classList.add('hidden');
  signOutBtn.classList.remove('hidden');
  authScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  setAuthMessage('');
  userNameLabel.textContent = currentUser.name || currentUser.email;
}

async function loadPhotosForBooking(bookingId) {
  const photoDocs = await loadPhotoDocs(bookingId);
  activePhotoRecords = photoDocs.reduce((acc, photo) => ({ ...acc, [photo.slot]: photo }), {});
}

function countUploadedPhotos() {
  return PHOTO_SLOTS.filter(slot => activePhotoRecords[slot.key]).length;
}

function renderAssignedList() {
  assignedList.innerHTML = '';
  if (assignedBookings.length === 0) {
    assignedList.innerHTML = '<div class="empty-state">Aucune mission ne vous est assignée pour le moment. L’équipe CleanFlow vous attribue vos missions.</div>';
    return;
  }
  assignedBookings.forEach(booking => {
    const item = document.createElement('div');
    item.className = 'task-card selectable' + (booking.id === selectedMissionId ? ' active' : '');
    item.innerHTML = `
      <div class="task-top">
        <div>
          <div class="task-title"></div>
          <div class="task-meta">${formatShortDate(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}</div>
        </div>
        <div class="status-pill ${booking.status}">${formatBookingStatus(booking.status)}</div>
      </div>
    `;
    item.querySelector('.task-title').textContent = booking.propertyAddress || booking.propertyId;
    item.onclick = async () => {
      selectedMissionId = booking.id;
      activeBooking = booking;
      await loadPhotosForBooking(booking.id);
      renderAssignedList();
      renderActiveBooking();
    };
    assignedList.appendChild(item);
  });
}

function buildStaticStars(value) {
  const stars = document.createElement('div');
  stars.className = 'stars-static';
  stars.setAttribute('role', 'img');
  stars.setAttribute('aria-label', `${value} étoile${value > 1 ? 's' : ''} sur 5`);
  for (let i = 1; i <= 5; i += 1) {
    const star = document.createElement('span');
    star.className = 'star-static' + (i <= value ? ' filled' : '');
    star.textContent = '★';
    star.setAttribute('aria-hidden', 'true');
    stars.appendChild(star);
  }
  return stars;
}

function renderRatings() {
  if (!ratingSummary) return;
  ratingSummary.innerHTML = '';
  ratingList.innerHTML = '';
  if (ratedBookings.length === 0) {
    ratingSummary.innerHTML = '<div class="empty-state">Aucune évaluation pour le moment. Les clients notent la prestation une fois vérifiée par l’équipe CleanFlow.</div>';
    return;
  }
  const average = ratedBookings.reduce((sum, b) => sum + b.rating, 0) / ratedBookings.length;
  const avgWrap = document.createElement('div');
  avgWrap.className = 'rating-avg';
  const num = document.createElement('span');
  num.className = 'rating-avg-num';
  num.textContent = average.toFixed(1);
  const out = document.createElement('span');
  out.className = 'rating-avg-out';
  out.textContent = '/ 5';
  avgWrap.appendChild(num);
  avgWrap.appendChild(out);
  avgWrap.appendChild(buildStaticStars(Math.round(average)));
  const sub = document.createElement('div');
  sub.className = 'task-meta';
  sub.textContent = `Moyenne sur ${ratedBookings.length} évaluation${ratedBookings.length > 1 ? 's' : ''}`;
  ratingSummary.appendChild(avgWrap);
  ratingSummary.appendChild(sub);

  ratedBookings.forEach(booking => {
    const item = document.createElement('div');
    item.className = 'task-card';
    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = booking.propertyAddress || booking.propertyId;
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    meta.textContent = `${formatShortDate(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}`;
    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(buildStaticStars(booking.rating));
    ratingList.appendChild(item);
  });
}

function renderActiveBooking() {
  activeBookingContainer.innerHTML = '';
  if (!activeBooking) return;
  const heading = document.createElement('div');
  heading.className = 'eyebrow';
  heading.textContent = `Dossier ${activeBooking.id.slice(0, 6).toUpperCase()} · ${formatBookingStatus(activeBooking.status)}`;
  const title = document.createElement('h2');
  title.textContent = activeBooking.propertyAddress || activeBooking.propertyId;
  const text = document.createElement('p');
  text.textContent = `${formatShortDate(activeBooking.scheduledDate)} · ${activeBooking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}${activeBooking.linenRequested ? ' · linge à changer' : ''}`;
  activeBookingContainer.appendChild(heading);
  activeBookingContainer.appendChild(title);
  activeBookingContainer.appendChild(text);

  if (activeBooking.status === 'rejected' && activeBooking.adminNote) {
    const note = document.createElement('div');
    note.className = 'status-banner';
    note.textContent = `Dossier renvoyé par CleanFlow : ${activeBooking.adminNote}`;
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
          setWorkStatus('');
          slotEl.classList.add('uploading');
          try {
            await withTimeout(uploadBookingImage({ bookingId: activeBooking.id, slot: slot.key, file, uploadedBy: currentUser.uid }), 30000);
            await loadPhotosForBooking(activeBooking.id);
            renderActiveBooking();
          } catch (e) {
            slotEl.classList.remove('uploading');
            setWorkStatus(`Photo « ${slot.label} » non envoyée : ${storageErrorMessage(e)}`);
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
    ? 'Dossier envoyé, en attente de vérification CleanFlow'
    : `Envoyer pour vérification (${count}/${PHOTO_SLOTS.length})`;
  button.disabled = !canUpload || count < PHOTO_SLOTS.length;
  button.onclick = async () => {
    try {
      await withButtonLoading(button, () =>
        withTimeout(updateDoc(doc(db, 'bookings', activeBooking.id), { status: 'submitted' }), 15000));
      queueEmail({
        to: TEAM_EMAIL,
        subject: `CleanFlow — dossier photos à vérifier · Réf ${activeBooking.id.slice(0, 6).toUpperCase()}`,
        text: `${activeBooking.propertyAddress || activeBooking.propertyId} · ${formatShortDate(activeBooking.scheduledDate)} · soumis par ${currentUser.name || currentUser.email}. À contrôler dans /admin/.`,
      });
    } catch (e) {
      setWorkStatus(`Impossible d’envoyer le dossier : ${storageErrorMessage(e)}`);
    }
  };
  activeBookingContainer.appendChild(button);

  if (activeBooking.status === 'accepted' || activeBooking.status === 'rejected') {
    const releaseBtn = document.createElement('button');
    releaseBtn.className = 'btn ghost danger';
    releaseBtn.type = 'button';
    releaseBtn.style.marginLeft = '12px';
    // Confirmation en deux temps sur le bouton lui-même : pas de window.confirm
    // (qui reste muet si les boîtes de dialogue ont été bloquées par le
    // navigateur), donc un clic produit toujours un retour visible.
    let armed = false;
    let armTimer = null;
    const disarm = () => {
      armed = false;
      releaseBtn.textContent = 'Décliner cette mission';
      releaseBtn.classList.remove('confirm');
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    };
    disarm();
    releaseBtn.onclick = async () => {
      if (!activeBooking) return;
      if (!armed) {
        armed = true;
        releaseBtn.textContent = 'Confirmer le désistement';
        releaseBtn.classList.add('confirm');
        armTimer = setTimeout(disarm, 5000);
        return;
      }
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
      const declinedId = activeBooking.id;
      const declinedRef = `${activeBooking.propertyAddress || activeBooking.propertyId} · ${formatShortDate(activeBooking.scheduledDate)}`;
      setWorkStatus('Désistement en cours…', 'info');
      try {
        await withButtonLoading(releaseBtn, () =>
          withTimeout(updateDoc(doc(db, 'bookings', declinedId), { status: 'pending', prestataireId: null }), 15000));
        queueEmail({
          to: TEAM_EMAIL,
          subject: `CleanFlow — mission déclinée · Réf ${declinedId.slice(0, 6).toUpperCase()}`,
          text: `${declinedRef} · déclinée par ${currentUser.name || currentUser.email}. À réattribuer dans /admin/.`,
        });
        setWorkStatus('Mission déclinée. L’équipe CleanFlow la réattribuera.', 'success');
      } catch (e) {
        console.error('Décliner mission — échec:', e);
        setWorkStatus(`Impossible de décliner la mission : ${authErrorMessage(e)}`);
      }
    };
    activeBookingContainer.appendChild(releaseBtn);
  }
}

function loadAssignedBookings() {
  if (assignedUnsub) assignedUnsub();
  // Filtre unique + tri côté client : aucun index composite à créer.
  const assignedQuery = query(collection(db, 'bookings'), where('prestataireId', '==', currentUser.uid));
  assignedUnsub = onSnapshot(assignedQuery, async snapshot => {
    const mine = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    assignedBookings = mine
      .filter(booking => ACTIONABLE_STATUSES.includes(booking.status))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
    ratedBookings = mine
      .filter(booking => booking.status === 'verified' && typeof booking.rating === 'number')
      .sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate));
    const stillThere = assignedBookings.find(b => b.id === selectedMissionId);
    activeBooking = stillThere || assignedBookings[0] || null;
    selectedMissionId = activeBooking ? activeBooking.id : null;
    if (activeBooking) {
      await loadPhotosForBooking(activeBooking.id);
    } else {
      activePhotoRecords = {};
    }
    renderAssignedList();
    renderActiveBooking();
    renderRatings();
  }, error => setWorkStatus(`Impossible de charger vos missions : ${storageErrorMessage(error)}`));
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    if (assignedUnsub) assignedUnsub();
    if (authNotice) {
      showAuth(authNotice.message, authNotice.type);
      authNotice = null;
    } else {
      showAuth();
    }
    return;
  }
  try {
    const docData = await loadUserDoc(user.uid);
    if (!docData || docData.role !== ROLE_PRESTATAIRE) {
      authNotice = { message: 'Ce compte n’est pas autorisé sur l’interface prestataire.', type: '' };
      await signOut(auth);
      return;
    }
    const accountStatus = docData.accountStatus ?? 'approved';
    if (accountStatus === 'pending') {
      authNotice = { message: 'Votre demande d’accès est en cours de vérification par l’équipe CleanFlow. Vous pourrez vous connecter dès qu’elle sera approuvée.', type: 'info' };
      await signOut(auth);
      return;
    }
    if (accountStatus === 'suspended') {
      authNotice = { message: 'Votre accès a été suspendu par l’équipe CleanFlow. Contactez-nous pour en savoir plus.', type: '' };
      await signOut(auth);
      return;
    }
    if (accountStatus !== 'approved') {
      authNotice = { message: 'Votre demande d’accès a été refusée. Contactez l’équipe CleanFlow si vous pensez qu’il s’agit d’une erreur.', type: '' };
      await signOut(auth);
      return;
    }
    currentUser = { uid: user.uid, ...docData };
    showApp();
    loadAssignedBookings();
  } catch (error) {
    authNotice = { message: authErrorMessage(error), type: '' };
    await signOut(auth);
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
  activeBooking = null;
  assignedBookings = [];
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
    await withButtonLoading(incidentForm.querySelector('button[type="submit"]'), async () => {
      if (file) {
        const incidentPath = `incidents/${activeBooking.id}/${Date.now()}_${file.name}`;
        const incidentRef = ref(storage, incidentPath);
        await withTimeout(uploadBytes(incidentRef, file, { contentType: file.type || 'image/jpeg' }), 30000);
        incidentPayload.photoRefs = [await withTimeout(getDownloadURL(incidentRef), 15000)];
      }
      await withTimeout(addDoc(collection(db, 'incidents'), incidentPayload), 15000);
    });
    incidentForm.reset();
    setIncidentMessage('Signalement envoyé à l’équipe CleanFlow.', 'success');
  } catch (err) {
    setIncidentMessage(`Impossible d’envoyer le signalement : ${storageErrorMessage(err)}`, 'error');
  }
});

switchToRequest.addEventListener('click', event => {
  event.preventDefault();
  signInForm.classList.add('hidden');
  requestForm.classList.remove('hidden');
  setAuthMessage('');
});

switchToSignIn.addEventListener('click', event => {
  event.preventDefault();
  requestForm.classList.add('hidden');
  signInForm.classList.remove('hidden');
  setAuthMessage('');
});

requestForm.addEventListener('submit', async event => {
  event.preventDefault();
  setAuthMessage('');
  const name = document.getElementById('requestName').value.trim();
  const phone = document.getElementById('requestPhone').value.trim();
  const email = document.getElementById('requestEmail').value.trim();
  const password = document.getElementById('requestPassword').value;
  const inviteCode = document.getElementById('requestCode').value.trim();
  try {
    await withButtonLoading(requestForm.querySelector('button[type="submit"]'), () =>
      requestTeamAccess({ role: ROLE_PRESTATAIRE, name, email, password, phone, inviteCode }));
    requestForm.reset();
    requestForm.classList.add('hidden');
    signInForm.classList.remove('hidden');
    setAuthMessage('Demande envoyée. L’équipe CleanFlow va la vérifier — vous pourrez vous connecter dès qu’elle sera approuvée.', 'success');
  } catch (err) {
    setAuthMessage(authErrorMessage(err), 'error');
  }
});

document.getElementById('forgotPassword').addEventListener('click', async event => {
  event.preventDefault();
  const email = document.getElementById('signInEmail').value.trim();
  if (!email) {
    setAuthMessage('Saisissez d’abord votre adresse email ci-dessus, puis cliquez à nouveau sur « Mot de passe oublié ? ».', 'info');
    return;
  }
  try {
    await resetPassword(email);
    setAuthMessage(`Email de réinitialisation envoyé à ${email}. Vérifiez votre boîte de réception (et vos spams).`, 'success');
  } catch (err) {
    setAuthMessage(authErrorMessage(err), 'error');
  }
});
