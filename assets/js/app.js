// Zebramoon, espace client : prochain ménage, biens, historique. La
// réservation elle-même (questions, date, extras, prix) vit dans
// booking-flow.js, monté ici pour « réserver un autre ménage » et pour
// terminer une réservation commencée sur la page d'accueil avant connexion.
import {
  auth,
  db,
  ROLE_CLIENT,
  loadUserDoc,
  registerClient,
  openDevisDocument,
  openLogementQr,
  ZONES,
  zoneLabel,
  formatShortDate,
  formatBookingStatus,
  authErrorMessage,
  withButtonLoading,
  armInlineConfirm,
  withTimeout,
  resetPassword,
  queueEmail,
  TEAM_EMAIL,
} from './shared.js';
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { mount as mountBookingFlow, reset as resetBookingFlow } from './booking-flow.js';

const loadingScreen = document.getElementById('loadingScreen');
const authScreen = document.getElementById('authScreen');
const appScreen = document.getElementById('appScreen');
const authError = document.getElementById('authError');
const authTitle = document.getElementById('authTitle');
const signInForm = document.getElementById('signInForm');
const registerForm = document.getElementById('registerForm');
const switchToRegister = document.getElementById('switchToRegister');
const switchToSignIn = document.getElementById('switchToSignIn');
const signOutBtn = document.getElementById('signOutBtn');
const userNameLabel = document.getElementById('userNameLabel');
const propertyList = document.getElementById('propertyList');
const bookingsWrap = document.getElementById('bookingsWrap');
const propertyForm = document.getElementById('propertyForm');
const propertyStreet = document.getElementById('propertyStreet');
const propertyCity = document.getElementById('propertyCity');
const propertyPostal = document.getElementById('propertyPostal');
const propertySurface = document.getElementById('propertySurface');
const propertyZone = document.getElementById('propertyZone');
const propertyTypeField = document.getElementById('propertyTypeField');
const propertyBedrooms = document.getElementById('propertyBedrooms');
const propertyBathrooms = document.getElementById('propertyBathrooms');
const propertyBeds = document.getElementById('propertyBeds');
const propertyNotes = document.getElementById('propertyNotes');
const propertyKeyAccess = document.getElementById('propertyKeyAccess');
const propertyFormTitle = document.getElementById('propertyFormTitle');
const propertySubmitBtn = document.getElementById('propertySubmitBtn');
const cancelEditWrap = document.getElementById('cancelEditWrap');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const propertyFormCard = document.getElementById('propertyFormCard');
const appStatus = document.getElementById('appStatus');
const welcomeText = document.getElementById('welcomeText');
const historyCard = document.getElementById('historyCard');
const nextCleaningBody = document.getElementById('nextCleaningBody');
const bookingFlowSection = document.getElementById('bookingFlowSection');
const bookingFlowRoot = document.getElementById('bookingFlowRoot');
const newBookingBtn = document.getElementById('newBookingBtn');

// Étapes affichées au client, la transparence du process est la promesse
// centrale de Zebramoon.
const BOOKING_STEPS = ['Réservée', 'Prise en charge', 'Ménage + photos', 'Confirmée'];
const STATUS_STEP = { pending: 0, accepted: 1, submitted: 2, rejected: 2, verified: 3 };

let currentUser = null;
let properties = [];
let bookings = [];
let propertiesUnsub = null;
let bookingsUnsub = null;
let authNotice = null;
let editingPropertyId = null;

// Une réservation encore en cours bloque la suppression du bien concerné.
const ACTIVE_BOOKING_STATUSES = ['pending', 'accepted', 'submitted', 'rejected'];

function populateZones() {
  propertyZone.innerHTML = '';
  ZONES.forEach(zone => {
    const option = document.createElement('option');
    option.value = zone.value;
    option.textContent = zone.label;
    propertyZone.appendChild(option);
  });
}

function setPropertyFormMode(property = null) {
  editingPropertyId = property ? property.id : null;
  propertyFormCard.open = !!property || properties.length === 0;
  propertyFormTitle.textContent = property ? 'Modifier le logement' : 'Ajouter un logement';
  propertySubmitBtn.textContent = property ? 'Enregistrer les modifications' : 'Enregistrer le logement';
  cancelEditWrap.classList.toggle('hidden', !property);
  propertyStreet.value = property ? property.street : '';
  propertyCity.value = property ? property.city : '';
  propertyPostal.value = property ? property.postalCode : '';
  propertySurface.value = property && property.surface ? property.surface : '';
  propertyZone.value = property && property.zone ? property.zone : (ZONES[0] ? ZONES[0].value : '');
  propertyTypeField.value = property && property.propertyType ? property.propertyType : 'appartement';
  propertyBedrooms.value = property && property.bedrooms != null ? property.bedrooms : '';
  propertyBathrooms.value = property && property.bathrooms != null ? property.bathrooms : '';
  propertyBeds.value = property && property.beds != null ? property.beds : '';
  propertyNotes.value = property ? (property.notes || '') : '';
  if (propertyKeyAccess) propertyKeyAccess.value = property ? (property.keyAccess || '') : '';
  if (property) {
    propertyForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    propertyStreet.focus();
  }
}

function showAuth(mode = 'signin', message = '') {
  loadingScreen.classList.add('hidden');
  signOutBtn.classList.add('hidden');
  authScreen.classList.remove('hidden');
  appScreen.classList.add('hidden');
  signInForm.classList.toggle('hidden', mode !== 'signin');
  registerForm.classList.toggle('hidden', mode !== 'register');
  authTitle.textContent = mode === 'signin' ? 'Connexion client' : 'Créer un compte client';
  authError.textContent = message;
  authError.classList.toggle('hidden', !message);
}

function showApp() {
  loadingScreen.classList.add('hidden');
  signOutBtn.classList.remove('hidden');
  authScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  authError.textContent = '';
  authError.classList.add('hidden');
  userNameLabel.textContent = currentUser.name || currentUser.email;
}

function setAuthMessage(message, type = '') {
  authError.textContent = message;
  authError.className = 'status-banner' + (type ? ` ${type}` : '') + (message ? '' : ' hidden');
}

function setAppStatus(text, type = 'info') {
  appStatus.textContent = text;
  appStatus.className = `status-banner ${type}` + (text ? '' : ' hidden');
}

// Divulgation progressive : tant qu'aucun bien n'est enregistré, on ne montre
// que l'étape utile (ajouter un bien) au lieu de tout l'écran d'un coup.
function updateOnboardingState() {
  const hasProperties = properties.length > 0;
  const hasBookings = bookings.length > 0;
  historyCard.classList.toggle('hidden', !hasBookings);
  if (!hasProperties) propertyFormCard.open = true;
  if (!hasProperties) {
    welcomeText.textContent = 'Bienvenue ! Réservez votre premier ménage, on vous demandera votre logement au fil des questions.';
  } else if (!hasBookings) {
    welcomeText.textContent = 'Votre logement est enregistré. Réservez un ménage quand vous voulez, le prix s’affiche avant confirmation.';
  } else {
    welcomeText.textContent = 'Réservez un ménage, suivez sa vérification par l’équipe Zebramoon, et recevez la confirmation une fois le contrôle photo effectué.';
  }
}

function propertyMetaText(prop) {
  return [
    prop.postalCode,
    prop.surface ? `${prop.surface} m²` : null,
    prop.bedrooms != null ? `${prop.bedrooms} chambre${prop.bedrooms > 1 ? 's' : ''}` : null,
    zoneLabel(prop.zone),
  ].filter(Boolean).join(' · ');
}

function renderPropertyButtons() {
  propertyList.innerHTML = '';
  if (properties.length === 0) {
    propertyList.innerHTML = '<div class="empty-state">Ajoutez un logement pour commencer, ou laissez la réservation le faire pour vous.</div>';
    return;
  }
  properties.forEach(prop => {
    const row = document.createElement('div');
    row.className = 'property-card';

    const info = document.createElement('div');
    info.className = 'property-select';
    info.style.cursor = 'default';
    const name = document.createElement('div');
    name.className = 'p-name';
    name.textContent = `${prop.street}, ${prop.city}`;
    const meta = document.createElement('div');
    meta.className = 'p-meta';
    meta.textContent = propertyMetaText(prop);
    const text = document.createElement('div');
    text.appendChild(name);
    text.appendChild(meta);
    info.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'property-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'mini-btn';
    editBtn.type = 'button';
    editBtn.textContent = 'Modifier';
    editBtn.setAttribute('aria-label', `Modifier ${prop.street}`);
    editBtn.onclick = () => setPropertyFormMode(prop);
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'mini-btn danger';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Supprimer';
    deleteBtn.setAttribute('aria-label', `Supprimer ${prop.street}`);
    armInlineConfirm(deleteBtn, 'Confirmer la suppression', async () => {
      try {
        await withTimeout(deleteDoc(doc(db, 'properties', prop.id)), 15000);
        if (editingPropertyId === prop.id) setPropertyFormMode(null);
        setAppStatus('Logement supprimé.', 'success');
      } catch (err) {
        setAppStatus(`Impossible de supprimer le logement : ${authErrorMessage(err)}`, 'error');
      }
    }, () => {
      const hasActiveBooking = bookings.some(b => b.propertyId === prop.id && ACTIVE_BOOKING_STATUSES.includes(b.status));
      if (hasActiveBooking) {
        setAppStatus('Impossible de supprimer ce logement : une réservation est en cours. Annulez-la d’abord ou attendez sa confirmation.', 'error');
        return false;
      }
      return true;
    });
    const qrBtn = document.createElement('button');
    qrBtn.className = 'mini-btn';
    qrBtn.type = 'button';
    qrBtn.textContent = 'QR logement';
    qrBtn.setAttribute('aria-label', `Imprimer le QR de ${prop.street}`);
    qrBtn.title = 'À imprimer et laisser dans le logement (contrôle Welcomer sur place)';
    qrBtn.onclick = () => { if (!openLogementQr(prop)) setAppStatus('Autorisez les fenêtres pop-up pour imprimer le QR.', 'error'); };
    actions.appendChild(editBtn);
    actions.appendChild(qrBtn);
    actions.appendChild(deleteBtn);

    row.appendChild(info);
    row.appendChild(actions);
    propertyList.appendChild(row);
  });
}

function upcomingBooking() {
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return bookings
    .filter(b => b.status !== 'cancelled' && b.scheduledDate >= todayIso)
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0] || null;
}

function renderNextCleaning() {
  const booking = upcomingBooking();
  if (!booking) {
    nextCleaningBody.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'next-clean-empty';
    const p = document.createElement('p');
    p.textContent = 'Aucun ménage prévu pour le moment.';
    wrap.appendChild(p);
    nextCleaningBody.appendChild(wrap);
    return;
  }
  const property = properties.find(p => p.id === booking.propertyId);
  const address = property ? `${property.street}, ${property.city}` : (booking.propertyAddress || 'Logement supprimé');
  nextCleaningBody.innerHTML = '';

  const addr = document.createElement('div');
  addr.className = 'next-clean-addr';
  addr.textContent = address;
  const meta = document.createElement('div');
  meta.className = 'next-clean-meta';
  meta.textContent = `${formatShortDate(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}`;
  nextCleaningBody.appendChild(addr);
  nextCleaningBody.appendChild(meta);

  const stage = STATUS_STEP[booking.status] ?? 0;
  const steps = document.createElement('div');
  steps.className = 'steps';
  steps.setAttribute('role', 'img');
  steps.setAttribute('aria-label', `Étape ${Math.min(stage + 1, BOOKING_STEPS.length)} sur ${BOOKING_STEPS.length} : ${BOOKING_STEPS[Math.min(stage, BOOKING_STEPS.length - 1)]}`);
  BOOKING_STEPS.forEach((label, index) => {
    const step = document.createElement('div');
    const isDone = booking.status === 'verified' ? true : index < stage;
    const isCurrent = booking.status !== 'verified' && index === stage;
    step.className = 'step' + (isDone ? ' done' : '') + (isCurrent ? ' current' : '');
    step.textContent = label;
    steps.appendChild(step);
  });
  nextCleaningBody.appendChild(steps);

  const foot = document.createElement('div');
  foot.className = 'next-clean-foot';
  const price = document.createElement('div');
  price.className = 'next-clean-price';
  price.textContent = `${booking.price}€`;
  const link = document.createElement('a');
  link.className = 'btn ghost';
  link.href = `#booking-${booking.id}`;
  link.textContent = 'Voir la réservation';
  foot.appendChild(price);
  foot.appendChild(link);
  nextCleaningBody.appendChild(foot);
}

function renderBookings() {
  bookingsWrap.innerHTML = '';
  if (bookings.length === 0) {
    bookingsWrap.innerHTML = '<div class="empty-state">Aucune réservation enregistrée pour le moment.</div>';
    return;
  }
  // Les plus récentes d'abord ; les annulées reléguées en bas, pour garder
  // en haut ce qui compte (prochain ménage, suivi en cours).
  const ordered = bookings.slice().sort((a, b) => {
    const aCancelled = a.status === 'cancelled';
    const bCancelled = b.status === 'cancelled';
    if (aCancelled !== bCancelled) return aCancelled ? 1 : -1;
    return b.scheduledDate.localeCompare(a.scheduledDate);
  });
  ordered.forEach(booking => {
    const property = properties.find(p => p.id === booking.propertyId);
    const address = property ? `${property.street}, ${property.city}` : (booking.propertyAddress || 'Bien supprimé');
    const card = document.createElement('div');
    card.id = `booking-${booking.id}`;
    card.className = 'dossier' + (booking.status === 'cancelled' ? ' cancelled' : '');
    card.innerHTML = `
      <div class="dossier-top">
        <div>
          <div class="dossier-addr"></div>
          <div class="dossier-meta">${formatShortDate(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}${booking.kitCount ? ` · ${booking.kitCount} kit(s)` : (booking.linenRequested ? ' · + linge' : '')}</div>
        </div>
        <div class="status-pill ${booking.status}">${formatBookingStatus(booking.status)}</div>
      </div>
      <div class="dossier-meta">${booking.price}€ · Réf ${booking.id.slice(0, 6).toUpperCase()}</div>
    `;
    card.querySelector('.dossier-addr').textContent = address;
    if (booking.status !== 'cancelled') {
      const stage = STATUS_STEP[booking.status] ?? 0;
      const steps = document.createElement('div');
      steps.className = 'steps';
      steps.setAttribute('role', 'img');
      steps.setAttribute('aria-label', `Étape ${Math.min(stage + 1, BOOKING_STEPS.length)} sur ${BOOKING_STEPS.length} : ${BOOKING_STEPS[Math.min(stage, BOOKING_STEPS.length - 1)]}`);
      BOOKING_STEPS.forEach((label, index) => {
        const step = document.createElement('div');
        const isDone = booking.status === 'verified' ? true : index < stage;
        const isCurrent = booking.status !== 'verified' && index === stage;
        step.className = 'step' + (isDone ? ' done' : '') + (isCurrent ? ' current' : '');
        step.textContent = label;
        steps.appendChild(step);
      });
      card.appendChild(steps);
      if (booking.status === 'rejected') {
        const note = document.createElement('div');
        note.className = 'dossier-note';
        note.textContent = 'Le contrôle qualité a demandé une correction au prestataire, votre ménage sera re-vérifié avant confirmation.';
        card.appendChild(note);
      }
    }
    // Annulable uniquement tant qu'aucun prestataire n'a accepté la mission
    // (même contrainte côté règles Firestore).
    if (booking.status === 'pending') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn ghost danger';
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Annuler la réservation';
      armInlineConfirm(cancelBtn, 'Confirmer l’annulation', async () => {
        try {
          await withButtonLoading(cancelBtn, () =>
            withTimeout(updateDoc(doc(db, 'bookings', booking.id), { status: 'cancelled' }), 15000));
          queueEmail({
            to: TEAM_EMAIL,
            subject: `Zebramoon, réservation annulée · Réf ${booking.id.slice(0, 6).toUpperCase()}`,
            text: `${address} · ${formatShortDate(booking.scheduledDate)} · annulée par le client ${currentUser.email}.`,
          });
          setAppStatus('Réservation annulée. La date est de nouveau disponible.', 'success');
        } catch (err) {
          setAppStatus('Impossible d’annuler : la mission vient peut-être d’être acceptée par un prestataire. Contactez l’équipe Zebramoon.', 'error');
        }
      });
      card.appendChild(cancelBtn);
    }
    // Note du client (1-5 étoiles) une fois la prestation vérifiée.
    if (booking.status === 'verified') {
      card.appendChild(buildRating(booking));
    }
    // Contacter l'équipe à propos de cette réservation (question, incident,
    // problème constaté après le ménage). Reste dispo même mission terminée.
    if (booking.status !== 'cancelled') {
      card.appendChild(buildContactTeam(booking, address));
      const devisBtn = document.createElement('button');
      devisBtn.className = 'mini-btn';
      devisBtn.type = 'button';
      devisBtn.style.paddingLeft = '0';
      devisBtn.textContent = 'Devis / reçu (PDF)';
      devisBtn.onclick = () => openDevisDocument(booking, currentUser);
      card.appendChild(devisBtn);
    }
    bookingsWrap.appendChild(card);
  });
}

function buildRating(booking) {
  const wrap = document.createElement('div');
  wrap.className = 'rating';
  const label = document.createElement('div');
  label.className = 'rating-label';
  label.textContent = booking.rating ? 'Votre note' : 'Notez cette prestation';
  const stars = document.createElement('div');
  stars.className = 'stars';
  stars.setAttribute('role', 'radiogroup');
  stars.setAttribute('aria-label', 'Note de 1 à 5 étoiles');
  for (let value = 1; value <= 5; value += 1) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star' + (booking.rating >= value ? ' filled' : '');
    star.textContent = '★';
    star.setAttribute('aria-label', `${value} étoile${value > 1 ? 's' : ''}`);
    star.onclick = async () => {
      if (star.disabled) return;
      stars.querySelectorAll('.star').forEach(s => { s.disabled = true; });
      try {
        await withTimeout(updateDoc(doc(db, 'bookings', booking.id), { rating: value, ratedAt: serverTimestamp() }), 15000);
        setAppStatus('Merci ! Votre note a bien été enregistrée.', 'success');
      } catch (err) {
        stars.querySelectorAll('.star').forEach(s => { s.disabled = false; });
        setAppStatus(`Impossible d’enregistrer la note : ${authErrorMessage(err)}`, 'error');
      }
    };
    stars.appendChild(star);
  }
  wrap.appendChild(label);
  wrap.appendChild(stars);
  return wrap;
}

function buildContactTeam(booking, address) {
  const wrap = document.createElement('div');
  wrap.className = 'contact-team';
  const toggle = document.createElement('button');
  toggle.className = 'mini-btn';
  toggle.type = 'button';
  toggle.textContent = 'Contacter l’équipe à propos de ce ménage';
  const form = document.createElement('div');
  form.className = 'contact-form hidden';
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Votre message à l’équipe Zebramoon (question, problème constaté, suite d’un incident…).';
  textarea.rows = 3;
  const send = document.createElement('button');
  send.className = 'btn primary';
  send.type = 'button';
  send.textContent = 'Envoyer à l’équipe';
  const note = document.createElement('div');
  note.className = 'note-box';
  toggle.onclick = () => {
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) textarea.focus();
  };
  send.onclick = async () => {
    const text = textarea.value.trim();
    if (!text) { note.textContent = 'Écrivez un message avant d’envoyer.'; return; }
    note.textContent = '';
    try {
      await withButtonLoading(send, () =>
        withTimeout(addDoc(collection(db, 'messages'), {
          bookingId: booking.id,
          clientId: currentUser.uid,
          clientEmail: currentUser.email,
          clientName: currentUser.name || '',
          propertyAddress: address,
          text,
          status: 'open',
          createdAt: serverTimestamp(),
        }), 15000));
      queueEmail({
        to: TEAM_EMAIL,
        subject: `Zebramoon, message client · Réf ${booking.id.slice(0, 6).toUpperCase()}`,
        text: `${currentUser.name || currentUser.email} (${currentUser.email}) à propos de ${address} (${formatShortDate(booking.scheduledDate)}) :\n\n${text}`,
      });
      textarea.value = '';
      form.classList.add('hidden');
      setAppStatus('Message envoyé à l’équipe Zebramoon. Vous serez recontacté par email ou téléphone.', 'success');
    } catch (err) {
      note.textContent = `Impossible d’envoyer le message : ${authErrorMessage(err)}`;
    }
  };
  form.appendChild(textarea);
  form.appendChild(send);
  form.appendChild(note);
  wrap.appendChild(toggle);
  wrap.appendChild(form);
  return wrap;
}

function subscribeData() {
  if (propertiesUnsub) propertiesUnsub();
  if (bookingsUnsub) bookingsUnsub();

  // Requêtes à filtre unique (tri côté client) : aucun index composite à créer.
  const propsQuery = query(collection(db, 'properties'), where('ownerId', '==', currentUser.uid));
  propertiesUnsub = onSnapshot(propsQuery, snapshot => {
    properties = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => a.street.localeCompare(b.street));
    renderPropertyButtons();
    updateOnboardingState();
    renderBookings();
    renderNextCleaning();
  }, error => setAppStatus(`Impossible de charger vos logements : ${authErrorMessage(error)}`, 'error'));

  const bookingsQuery = query(collection(db, 'bookings'), where('clientId', '==', currentUser.uid));
  bookingsUnsub = onSnapshot(bookingsQuery, snapshot => {
    bookings = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
    renderBookings();
    updateOnboardingState();
    renderNextCleaning();
  }, error => setAppStatus(`Impossible de charger vos réservations : ${authErrorMessage(error)}`, 'error'));
}

// Le widget de réservation gère lui-même son état (auth, brouillon,
// abonnements Firestore) : on le monte une fois, en le gardant masqué tant
// que le client n'a pas cliqué sur « Réserver » ou qu'aucun brouillon en
// attente d'authentification n'a besoin d'être terminé ici.
function draftAwaitingSubmit() {
  try {
    const raw = sessionStorage.getItem('zm_booking_draft');
    if (!raw) return false;
    return !!JSON.parse(raw).readyToSubmit;
  } catch { return false; }
}

function showBookingFlow() {
  bookingFlowSection.classList.remove('hidden');
  bookingFlowSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

mountBookingFlow(bookingFlowRoot, {});
if (draftAwaitingSubmit()) showBookingFlow();

newBookingBtn.addEventListener('click', () => {
  resetBookingFlow();
  showBookingFlow();
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    if (propertiesUnsub) propertiesUnsub();
    if (bookingsUnsub) bookingsUnsub();
    if (authNotice) {
      showAuth(authNotice.mode, authNotice.message);
      authNotice = null;
    } else {
      showAuth('signin');
    }
    return;
  }
  try {
    const docData = await loadUserDoc(user.uid);
    if (!docData) {
      authNotice = { mode: 'register', message: 'Compte introuvable. Veuillez créer un compte client.' };
      await signOut(auth);
      return;
    }
    if (docData.role !== ROLE_CLIENT) {
      authNotice = { mode: 'signin', message: 'Ce compte n’est pas autorisé sur l’interface client.' };
      await signOut(auth);
      return;
    }
    currentUser = { uid: user.uid, ...docData };
    showApp();
    subscribeData();
  } catch (error) {
    authNotice = { mode: 'signin', message: authErrorMessage(error) };
    await signOut(auth);
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

switchToRegister.addEventListener('click', event => {
  event.preventDefault();
  showAuth('register');
});

switchToSignIn.addEventListener('click', event => {
  event.preventDefault();
  showAuth('signin');
});

signInForm.addEventListener('submit', async event => {
  event.preventDefault();
  authError.classList.add('hidden');
  const email = document.getElementById('signInEmail').value.trim();
  const password = document.getElementById('signInPassword').value;
  try {
    await withButtonLoading(signInForm.querySelector('button[type="submit"]'),
      () => signInWithEmailAndPassword(auth, email, password));
  } catch (err) {
    showAuth('signin', authErrorMessage(err));
  }
});

registerForm.addEventListener('submit', async event => {
  event.preventDefault();
  authError.classList.add('hidden');
  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value;
  const name = document.getElementById('registerName').value.trim();
  const phone = document.getElementById('registerPhone').value.trim();
  try {
    await withButtonLoading(registerForm.querySelector('button[type="submit"]'),
      () => registerClient({ name, email, password, phone }));
  } catch (err) {
    showAuth('register', authErrorMessage(err));
  }
});

signOutBtn.addEventListener('click', async () => {
  await signOut(auth);
  properties = [];
  bookings = [];
});

propertyForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser) return;
  const street = propertyStreet.value.trim();
  const city = propertyCity.value.trim();
  const postalCode = propertyPostal.value.trim();
  const surface = Math.floor(Number(propertySurface.value) || 0);
  const zone = propertyZone.value;
  const propertyType = propertyTypeField.value;
  const bedrooms = propertyBedrooms.value === '' ? null : Math.max(0, Math.floor(Number(propertyBedrooms.value) || 0));
  const bathrooms = propertyBathrooms.value === '' ? null : Math.max(0, Math.floor(Number(propertyBathrooms.value) || 0));
  const beds = propertyBeds.value === '' ? null : Math.max(0, Math.floor(Number(propertyBeds.value) || 0));
  const notes = propertyNotes.value.trim();
  const keyAccess = propertyKeyAccess ? propertyKeyAccess.value.trim() : '';
  if (!street || !city || !postalCode) {
    setAppStatus('Veuillez renseigner l’adresse complète du logement.', 'error');
    return;
  }
  if (!surface || surface <= 0) {
    setAppStatus('Indiquez la surface du logement (en m²) : elle détermine le tarif.', 'error');
    return;
  }
  if (!zone) {
    setAppStatus('Sélectionnez la zone du logement.', 'error');
    return;
  }
  const fields = { street, city, postalCode, surface, zone, propertyType, bedrooms, bathrooms, beds, notes, keyAccess };
  try {
    if (editingPropertyId) {
      const propertyId = editingPropertyId;
      const newAddress = `${street}, ${city}`;
      // Recopie la nouvelle adresse sur les réservations en cours de ce bien
      // pour que prestataire et livreur ne voient jamais l'ancienne.
      const affected = bookings.filter(b => b.propertyId === propertyId && ACTIVE_BOOKING_STATUSES.includes(b.status));
      await withButtonLoading(propertySubmitBtn, () => withTimeout((async () => {
        await updateDoc(doc(db, 'properties', propertyId), fields);
        await Promise.all(affected.map(b =>
          updateDoc(doc(db, 'bookings', b.id), { propertyAddress: newAddress, keyAccess })));
      })(), 20000));
      setPropertyFormMode(null);
      setAppStatus(affected.length
        ? 'Logement modifié. Les réservations en cours ont été mises à jour.'
        : 'Logement modifié.', 'success');
    } else {
      await withButtonLoading(propertySubmitBtn, () =>
        withTimeout(addDoc(collection(db, 'properties'), {
          ownerId: currentUser.uid,
          ...fields,
          createdAt: serverTimestamp(),
        }), 15000));
      propertyForm.reset();
      propertyFormCard.open = false;
      setAppStatus('Logement ajouté. Vous pouvez réserver maintenant.', 'success');
    }
  } catch (err) {
    setAppStatus(`Impossible d’enregistrer le logement : ${authErrorMessage(err)}`, 'error');
  }
});

cancelEditBtn.addEventListener('click', event => {
  event.preventDefault();
  setPropertyFormMode(null);
});

populateZones();
