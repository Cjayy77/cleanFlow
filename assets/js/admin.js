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
  resetPassword,
  requestTeamAccess,
  queueEmail,
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
const requestForm = document.getElementById('requestForm');
const switchToRequest = document.getElementById('switchToRequest');
const switchToSignIn = document.getElementById('switchToSignIn');
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
const statPending = document.getElementById('statPending');
const statAccepted = document.getElementById('statAccepted');
const statSubmitted = document.getElementById('statSubmitted');
const statVerified = document.getElementById('statVerified');
const openIncidents = document.getElementById('openIncidents');
const clientMessages = document.getElementById('clientMessages');
const missionsToAssign = document.getElementById('missionsToAssign');
const kitsToAssign = document.getElementById('kitsToAssign');

let currentUser = null;
let authNotice = null;
let selectedBooking = null;
let bookingQueueData = [];
let bookingQueueUnsub = null;
let statsUnsub = null;
let incidentsUnsub = null;
let messagesUnsub = null;
let latestBookings = [];
let prestataires = [];
let livreurs = [];
let membersUnsubs = [];

function subscribeStats() {
  if (statsUnsub) statsUnsub();
  statsUnsub = onSnapshot(collection(db, 'bookings'), snapshot => {
    latestBookings = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    const counts = { pending: 0, accepted: 0, submitted: 0, verified: 0 };
    latestBookings.forEach(booking => {
      if (counts[booking.status] !== undefined) counts[booking.status] += 1;
    });
    statPending.textContent = counts.pending;
    statAccepted.textContent = counts.accepted;
    statSubmitted.textContent = counts.submitted;
    statVerified.textContent = counts.verified;
    renderAssignments();
  }, error => setAdminStatus(`Impossible de charger la vue d’ensemble : ${authErrorMessage(error)}`, 'error'));
}

// Prestataires et livreurs approuvés, pour les listes déroulantes d'assignation.
function subscribeTeamMembers() {
  membersUnsubs.forEach(unsub => unsub());
  membersUnsubs = [];
  const assign = { prestataire: list => { prestataires = list; }, livreur: list => { livreurs = list; } };
  ['prestataire', 'livreur'].forEach(role => {
    const unsub = onSnapshot(query(collection(db, 'users'), where('role', '==', role)), snapshot => {
      const list = snapshot.docs
        .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
        .filter(member => (member.accountStatus ?? 'approved') === 'approved')
        .sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));
      assign[role](list);
      renderAssignments();
    }, error => setAdminStatus(`Impossible de charger l’équipe : ${authErrorMessage(error)}`, 'error'));
    membersUnsubs.push(unsub);
  });
}

function buildMemberSelect(members, placeholder) {
  const select = document.createElement('select');
  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  select.appendChild(first);
  members.forEach(member => {
    const option = document.createElement('option');
    option.value = member.id;
    option.textContent = member.name || member.email;
    select.appendChild(option);
  });
  return select;
}

function appendAssignCard(container, booking, members, placeholder, noMembersNote, metaText, assignFn) {
  const card = document.createElement('div');
  card.className = 'task-card';
  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = booking.propertyAddress || booking.propertyId;
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  meta.textContent = metaText;
  card.appendChild(title);
  card.appendChild(meta);
  if (members.length === 0) {
    const note = document.createElement('div');
    note.className = 'task-meta';
    note.textContent = noMembersNote;
    card.appendChild(note);
    container.appendChild(card);
    return;
  }
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; align-items:center;';
  const select = buildMemberSelect(members, placeholder);
  const assignBtn = document.createElement('button');
  assignBtn.className = 'btn primary';
  assignBtn.type = 'button';
  assignBtn.textContent = 'Assigner';
  assignBtn.onclick = () => assignFn(select.value, assignBtn);
  row.appendChild(select);
  row.appendChild(assignBtn);
  card.appendChild(row);
  container.appendChild(card);
}

function renderAssignments() {
  renderMissionsToAssign();
  renderKitsToAssign();
}

function renderMissionsToAssign() {
  if (!missionsToAssign) return;
  missionsToAssign.innerHTML = '';
  const pending = latestBookings
    .filter(booking => booking.status === 'pending')
    .sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''));
  if (pending.length === 0) {
    missionsToAssign.innerHTML = '<div class="empty-state">Aucune réservation en attente d’assignation.</div>';
    return;
  }
  pending.forEach(booking => {
    const metaText = `${formatShortDate(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}${booking.linenRequested ? ' · + kits' : ''} · ${booking.price}€`;
    appendAssignCard(missionsToAssign, booking, prestataires, 'Choisir un prestataire…',
      'Aucun prestataire approuvé. Approuvez d’abord une demande d’accès.', metaText,
      async (prestataireId, assignBtn) => {
        if (!prestataireId) { setAdminStatus('Choisissez un prestataire avant d’assigner.', 'error'); return; }
        const member = prestataires.find(p => p.id === prestataireId);
        try {
          await withButtonLoading(assignBtn, () =>
            updateDoc(doc(db, 'bookings', booking.id), { prestataireId, status: 'accepted' }));
          if (member?.email) {
            queueEmail({
              to: member.email,
              subject: `Kleining — nouvelle mission assignée · Réf ${booking.id.slice(0, 6).toUpperCase()}`,
              text: `${booking.propertyAddress || 'Mission'} · ${formatShortDate(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}. Retrouvez-la dans votre interface prestataire.`,
            });
          }
          setAdminStatus(`Mission assignée à ${member?.name || member?.email || 'ce prestataire'}.`, 'success');
        } catch (e) {
          setAdminStatus(`Impossible d’assigner la mission : ${authErrorMessage(e)}`, 'error');
        }
      });
  });
}

function renderKitsToAssign() {
  if (!kitsToAssign) return;
  kitsToAssign.innerHTML = '';
  const needing = latestBookings
    .filter(booking => booking.linenRequested === true && !booking.livreurId && booking.status !== 'cancelled')
    .sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''));
  if (needing.length === 0) {
    kitsToAssign.innerHTML = '<div class="empty-state">Aucune livraison de kits en attente d’assignation.</div>';
    return;
  }
  needing.forEach(booking => {
    const metaText = `${formatShortDate(booking.scheduledDate)} · dépôt kits / linge propre + récupération`;
    appendAssignCard(kitsToAssign, booking, livreurs, 'Choisir un livreur…',
      'Aucun livreur approuvé. Approuvez d’abord une demande d’accès.', metaText,
      async (livreurId, assignBtn) => {
        if (!livreurId) { setAdminStatus('Choisissez un livreur avant d’assigner.', 'error'); return; }
        const member = livreurs.find(l => l.id === livreurId);
        try {
          await withButtonLoading(assignBtn, () =>
            updateDoc(doc(db, 'bookings', booking.id), { livreurId }));
          if (member?.email) {
            queueEmail({
              to: member.email,
              subject: `Kleining — nouvelle tournée assignée · Réf ${booking.id.slice(0, 6).toUpperCase()}`,
              text: `${booking.propertyAddress || 'Tournée'} · ${formatShortDate(booking.scheduledDate)} · dépôt des kits / linge propre et récupération. Retrouvez-la dans votre interface livreur.`,
            });
          }
          setAdminStatus(`Tournée assignée à ${member?.name || member?.email || 'ce livreur'}.`, 'success');
        } catch (e) {
          setAdminStatus(`Impossible d’assigner la tournée : ${authErrorMessage(e)}`, 'error');
        }
      });
  });
}

function subscribeOpenIncidents() {
  if (incidentsUnsub) incidentsUnsub();
  const openQuery = query(collection(db, 'incidents'), where('status', '==', 'open'));
  incidentsUnsub = onSnapshot(openQuery, snapshot => {
    const incidents = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => (b.reportedAt?.toMillis?.() || 0) - (a.reportedAt?.toMillis?.() || 0));
    renderOpenIncidents(incidents);
  }, error => setAdminStatus(`Impossible de charger les incidents : ${authErrorMessage(error)}`, 'error'));
}

function subscribeClientMessages() {
  if (messagesUnsub) messagesUnsub();
  const openMsgQuery = query(collection(db, 'messages'), where('status', '==', 'open'));
  messagesUnsub = onSnapshot(openMsgQuery, snapshot => {
    const messages = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    renderClientMessages(messages);
  }, error => setAdminStatus(`Impossible de charger les messages clients : ${authErrorMessage(error)}`, 'error'));
}

function renderClientMessages(messages) {
  clientMessages.innerHTML = '';
  if (messages.length === 0) {
    clientMessages.innerHTML = '<div class="empty-state">Aucun message client en attente.</div>';
    return;
  }
  messages.forEach(message => {
    const item = document.createElement('div');
    item.className = 'incident-item';
    const title = document.createElement('strong');
    title.textContent = `${message.clientName || message.clientEmail || 'Client'} · Réf ${(message.bookingId || '').slice(0, 6).toUpperCase()}`;
    const contact = document.createElement('div');
    contact.className = 'task-meta';
    contact.textContent = `${message.clientEmail || ''} · ${message.propertyAddress || ''}`;
    const body = document.createElement('div');
    body.className = 'task-meta';
    body.style.color = 'var(--ink)';
    body.style.marginTop = '8px';
    body.textContent = message.text;
    item.appendChild(title);
    item.appendChild(contact);
    item.appendChild(body);
    const resolveBtn = document.createElement('button');
    resolveBtn.className = 'btn ghost';
    resolveBtn.type = 'button';
    resolveBtn.textContent = 'Marquer traité';
    resolveBtn.style.marginTop = '12px';
    resolveBtn.onclick = async () => {
      try {
        await withButtonLoading(resolveBtn, () =>
          updateDoc(doc(db, 'messages', message.id), { status: 'resolved' }));
      } catch (e) {
        setAdminStatus(`Impossible de clore le message : ${authErrorMessage(e)}`, 'error');
      }
    };
    item.appendChild(resolveBtn);
    clientMessages.appendChild(item);
  });
}

function renderOpenIncidents(incidents) {
  openIncidents.innerHTML = '';
  if (incidents.length === 0) {
    openIncidents.innerHTML = '<div class="empty-state">Aucun incident ouvert.</div>';
    return;
  }
  incidents.forEach(incident => {
    const item = document.createElement('div');
    item.className = 'incident-item';
    const typeLabel = incident.type === 'broken_object' ? 'Objet cassé' : incident.type === 'lost_object' ? 'Objet perdu' : 'Autre';
    const title = document.createElement('strong');
    title.textContent = `${typeLabel} · Réf ${(incident.bookingId || '').slice(0, 6).toUpperCase()}`;
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
    const resolveBtn = document.createElement('button');
    resolveBtn.className = 'btn ghost';
    resolveBtn.type = 'button';
    resolveBtn.textContent = 'Marquer traité';
    resolveBtn.style.marginTop = '12px';
    resolveBtn.onclick = async () => {
      try {
        await withButtonLoading(resolveBtn, () =>
          updateDoc(doc(db, 'incidents', incident.id), { status: 'resolved' }));
      } catch (e) {
        setAdminStatus(`Impossible de clore l’incident : ${authErrorMessage(e)}`, 'error');
      }
    };
    item.appendChild(resolveBtn);
    openIncidents.appendChild(item);
  });
}

function setAuthMessage(message, type = '') {
  authError.textContent = message;
  authError.className = 'status-banner' + (type ? ` ${type}` : '') + (message ? '' : ' hidden');
}

function setAdminStatus(message = '', type = 'info') {
  adminStatus.textContent = message;
  adminStatus.className = `status-banner ${type}` + (message ? '' : ' hidden');
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
    try {
      await refreshBookingDetail();
    } catch (e) {
      setAdminStatus(`Impossible de charger le détail du dossier : ${authErrorMessage(e)}`, 'error');
    }
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
  }, error => setAdminStatus(`Impossible de charger la file de vérification : ${authErrorMessage(error)}`, 'error'));
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
    if (status === 'verified' && selectedBooking.clientEmail) {
      queueEmail({
        to: selectedBooking.clientEmail,
        subject: `Kleining — votre ménage du ${formatShortDate(selectedBooking.scheduledDate)} est confirmé ✓`,
        text: `Bonne nouvelle : le ménage de ${selectedBooking.propertyAddress || 'votre bien'} a été réalisé, son dossier photo a été contrôlé et validé par l’équipe Kleining. Retrouvez le détail dans votre espace client.`,
      });
    }
    if (status === 'rejected' && selectedBooking.prestataireId) {
      try {
        const prestataireSnap = await getDoc(doc(db, 'users', selectedBooking.prestataireId));
        if (prestataireSnap.exists() && prestataireSnap.data().email) {
          queueEmail({
            to: prestataireSnap.data().email,
            subject: `Kleining — dossier à corriger · Réf ${selectedBooking.id.slice(0, 6).toUpperCase()}`,
            text: `Le dossier de ${selectedBooking.propertyAddress || 'la mission'} (${formatShortDate(selectedBooking.scheduledDate)}) a été renvoyé pour correction. Note de l’équipe : ${note}. Corrigez les photos puis re-soumettez depuis votre interface.`,
          });
        }
      } catch (e) { /* la notification ne doit jamais bloquer le verdict */ }
    }
    rejectNote.value = '';
    setAdminStatus(status === 'verified'
      ? 'Dossier validé. Le client est notifié par email.'
      : 'Dossier renvoyé au prestataire pour correction (notifié par email).');
  } catch (err) {
    setAdminStatus(`Impossible de mettre à jour le dossier : ${authErrorMessage(err)}`, 'error');
  } finally {
    actionBtn.classList.remove('loading');
  }
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    if (bookingQueueUnsub) bookingQueueUnsub();
    if (accessUnsub) accessUnsub();
    if (statsUnsub) statsUnsub();
    if (incidentsUnsub) incidentsUnsub();
    if (messagesUnsub) messagesUnsub();
    membersUnsubs.forEach(unsub => unsub());
    membersUnsubs = [];
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
    if (!docData || docData.role !== ROLE_ADMIN) {
      authNotice = { message: 'Ce compte n’est pas autorisé sur l’interface admin.', type: '' };
      await signOut(auth);
      return;
    }
    const accountStatus = docData.accountStatus ?? 'approved';
    if (accountStatus === 'pending') {
      authNotice = { message: 'Votre demande d’accès est en cours de vérification par l’équipe Kleining. Vous pourrez vous connecter dès qu’elle sera approuvée.', type: 'info' };
      await signOut(auth);
      return;
    }
    if (accountStatus !== 'approved') {
      authNotice = { message: 'Votre demande d’accès a été refusée. Contactez l’équipe Kleining si vous pensez qu’il s’agit d’une erreur.', type: '' };
      await signOut(auth);
      return;
    }
    currentUser = { uid: user.uid, ...docData };
    showApp();
    refreshQueue();
    subscribeAccessRequests();
    subscribeStats();
    subscribeTeamMembers();
    subscribeOpenIncidents();
    subscribeClientMessages();
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
  selectedBooking = null;
  bookingQueueData = [];
});

verifyBtn.addEventListener('click', () => resolveBooking('verified'));
rejectBtn.addEventListener('click', () => resolveBooking('rejected'));

const teamStatus = document.getElementById('teamStatus');
const accessRequests = document.getElementById('accessRequests');
const ROLE_LABELS = { prestataire: 'Prestataire', livreur: 'Livreur', admin: 'Admin' };
let accessUnsub = null;

function setTeamStatus(message, type = 'info') {
  teamStatus.textContent = message;
  teamStatus.className = `status-banner ${type}` + (message ? '' : ' hidden');
}

function buildAccessRequestCard(req) {
  const card = document.createElement('div');
  card.className = 'task-card';
  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = `${ROLE_LABELS[req.role] || req.role} — ${req.name || '(sans nom)'}`;
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  meta.textContent = `${req.email || ''} · ${req.phone || ''}`;
  const code = document.createElement('div');
  code.className = 'task-meta';
  code.textContent = req.inviteCode ? `Code d’invitation : ${req.inviteCode}` : 'Aucun code d’invitation fourni';
  if (req.inviteCode) code.style.fontWeight = '700';
  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(code);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:10px; flex-wrap:wrap;';
  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn primary';
  approveBtn.type = 'button';
  approveBtn.textContent = 'Approuver';
  approveBtn.onclick = async () => {
    try {
      await withButtonLoading(approveBtn, () =>
        updateDoc(doc(db, 'users', req.id), { accountStatus: 'approved' }));
      setTeamStatus(`Accès ${req.role} approuvé pour ${req.name}. La personne peut maintenant se connecter.`, 'success');
    } catch (e) {
      setTeamStatus('Impossible d’approuver cette demande.', 'error');
    }
  };
  const refuseBtn = document.createElement('button');
  refuseBtn.className = 'btn ghost danger';
  refuseBtn.type = 'button';
  refuseBtn.textContent = 'Refuser';
  refuseBtn.onclick = async () => {
    if (!window.confirm(`Refuser l’accès ${req.role} demandé par ${req.name} ?`)) return;
    try {
      await withButtonLoading(refuseBtn, () =>
        updateDoc(doc(db, 'users', req.id), { accountStatus: 'rejected' }));
      setTeamStatus(`Demande de ${req.name} refusée. Ce compte n’a accès à aucune interface.`, 'success');
    } catch (e) {
      setTeamStatus('Impossible de refuser cette demande.', 'error');
    }
  };
  actions.appendChild(approveBtn);
  actions.appendChild(refuseBtn);
  card.appendChild(actions);
  return card;
}

function renderAccessRequests(requests) {
  accessRequests.innerHTML = '';
  if (requests.length === 0) {
    accessRequests.innerHTML = '<div class="empty-state">Aucune demande d’accès en attente.</div>';
    return;
  }
  requests.forEach(req => accessRequests.appendChild(buildAccessRequestCard(req)));
}

function subscribeAccessRequests() {
  if (accessUnsub) accessUnsub();
  const pendingAccessQuery = query(collection(db, 'users'), where('accountStatus', '==', 'pending'));
  accessUnsub = onSnapshot(pendingAccessQuery, snapshot => {
    const requests = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
    renderAccessRequests(requests);
  }, error => setTeamStatus(`Impossible de charger les demandes d’accès : ${authErrorMessage(error)}`, 'error'));
}

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
      requestTeamAccess({ role: ROLE_ADMIN, name, email, password, phone, inviteCode }));
    requestForm.reset();
    requestForm.classList.add('hidden');
    signInForm.classList.remove('hidden');
    setAuthMessage('Demande envoyée. L’équipe Kleining va la vérifier — vous pourrez vous connecter dès qu’elle sera approuvée.', 'success');
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
