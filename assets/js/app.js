// Kleining — espace client : biens, calendrier de réservation, historique.
import {
  auth,
  db,
  ROLE_CLIENT,
  loadUserDoc,
  registerClient,
  formatPrice,
  formatShortDate,
  formatBookingStatus,
  authErrorMessage,
  withButtonLoading,
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
  doc,
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
const authTitle = document.getElementById('authTitle');
const signInForm = document.getElementById('signInForm');
const registerForm = document.getElementById('registerForm');
const switchToRegister = document.getElementById('switchToRegister');
const switchToSignIn = document.getElementById('switchToSignIn');
const signOutBtn = document.getElementById('signOutBtn');
const userNameLabel = document.getElementById('userNameLabel');
const propertyList = document.getElementById('propertyList');
const calendarGrid = document.getElementById('calendarGrid');
const calMonthLabel = document.getElementById('calMonthLabel');
const calPrev = document.getElementById('calPrev');
const calNext = document.getElementById('calNext');
const selectedDateLabel = document.getElementById('selectedDateLabel');
const serviceRadios = document.querySelectorAll('input[name="serviceType"]');
const priceValue = document.getElementById('priceValue');
const bookBtn = document.getElementById('bookBtn');
const bookingsWrap = document.getElementById('bookingsWrap');
const propertyForm = document.getElementById('propertyForm');
const propertyStreet = document.getElementById('propertyStreet');
const propertyCity = document.getElementById('propertyCity');
const propertyPostal = document.getElementById('propertyPostal');
const propertyNotes = document.getElementById('propertyNotes');
const linenToggle = document.getElementById('linenToggle');
const appStatus = document.getElementById('appStatus');
const welcomeText = document.getElementById('welcomeText');
const bookingCard = document.getElementById('bookingCard');
const historyCard = document.getElementById('historyCard');
const bookingFor = document.getElementById('bookingFor');

// Étapes affichées au client — la transparence du process est la promesse
// centrale de Kleining.
const BOOKING_STEPS = ['Réservée', 'Prise en charge', 'Ménage + photos', 'Confirmée'];
const STATUS_STEP = { pending: 0, accepted: 1, submitted: 2, rejected: 2, verified: 3 };

let currentUser = null;
let selectedPropertyId = null;
let selectedDate = null;
let selectedServiceType = 'normal';
let linenRequested = false;
let properties = [];
let bookings = [];
let propertiesUnsub = null;
let bookingsUnsub = null;
let authNotice = null;
let calendarMonth = startOfMonth(new Date());

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
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

function updateBookingBar() {
  const price = formatPrice(selectedServiceType);
  // TODO: confirm with team — le linge est-il facturé en plus des deux forfaits ?
  priceValue.textContent = `${price}€`;
  bookBtn.textContent = selectedDate ? `Réserver le ${formatShortDate(selectedDate)} · ${price}€` : 'Choisir une date pour réserver';
  bookBtn.disabled = !selectedPropertyId || !selectedDate;
  const property = properties.find(p => p.id === selectedPropertyId);
  bookingFor.textContent = property ? `Pour : ${property.street}, ${property.city}` : '';
}

// Divulgation progressive : tant qu'aucun bien n'est enregistré, on ne montre
// que l'étape utile (ajouter un bien) au lieu de tout l'écran d'un coup.
function updateOnboardingState() {
  const hasProperties = properties.length > 0;
  const hasBookings = bookings.length > 0;
  bookingCard.classList.toggle('hidden', !hasProperties);
  historyCard.classList.toggle('hidden', !hasProperties && !hasBookings);
  if (!hasProperties) {
    welcomeText.textContent = 'Bienvenue ! Première étape : enregistrez votre bien ci-dessous. Vous pourrez ensuite réserver votre premier ménage sur son calendrier.';
  } else if (!hasBookings) {
    welcomeText.textContent = 'Votre bien est enregistré. Choisissez une date sur le calendrier, le prix est affiché avant confirmation.';
  } else {
    welcomeText.textContent = 'Réservez un ménage, suivez sa vérification par l’équipe Kleining, et recevez la confirmation une fois le contrôle photo effectué.';
  }
}

function renderPropertyButtons() {
  propertyList.innerHTML = '';
  if (properties.length === 0) {
    propertyList.innerHTML = '<div class="empty-state">Ajoutez un bien pour commencer.</div>';
    selectedPropertyId = null;
    return;
  }
  properties.forEach(prop => {
    const button = document.createElement('button');
    button.className = 'property-card' + (selectedPropertyId === prop.id ? ' selected' : '');
    button.type = 'button';
    const name = document.createElement('div');
    name.className = 'p-name';
    name.textContent = `${prop.street}, ${prop.city}`;
    const meta = document.createElement('div');
    meta.className = 'p-meta';
    meta.textContent = prop.postalCode;
    const thumb = document.createElement('div');
    thumb.className = 'p-thumb';
    const text = document.createElement('div');
    text.appendChild(name);
    text.appendChild(meta);
    button.appendChild(thumb);
    button.appendChild(text);
    button.onclick = () => {
      selectedPropertyId = prop.id;
      selectedDate = null;
      selectedDateLabel.value = 'Aucune date';
      renderCalendar();
      updateBookingBar();
      renderPropertyButtons();
    };
    propertyList.appendChild(button);
  });
}

function renderCalendar() {
  calendarGrid.innerHTML = '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const currentMonth = startOfMonth(today);
  if (calendarMonth < currentMonth) calendarMonth = currentMonth;

  const monthLabel = calendarMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  calMonthLabel.textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
  calPrev.disabled = calendarMonth.getTime() === currentMonth.getTime();

  ['L', 'M', 'M', 'J', 'V', 'S', 'D'].forEach(label => {
    const div = document.createElement('div');
    div.className = 'cal-day-label';
    div.textContent = label;
    calendarGrid.appendChild(div);
  });

  const takenDates = bookings
    .filter(b => b.propertyId === selectedPropertyId && !['rejected', 'cancelled'].includes(b.status))
    .map(b => b.scheduledDate);

  // Semaine française : lundi en première colonne.
  const mondayOffset = (calendarMonth.getDay() + 6) % 7;
  for (let i = 0; i < mondayOffset; i += 1) {
    const filler = document.createElement('div');
    filler.className = 'cal-day empty';
    filler.setAttribute('aria-hidden', 'true');
    calendarGrid.appendChild(filler);
  }

  const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum += 1) {
    const day = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), dayNum);
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const isPast = day < today;
    const isBooked = takenDates.includes(iso);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cal-day'
      + (isPast ? ' past' : '')
      + (isBooked ? ' booked' : '')
      + (selectedDate === iso ? ' selected' : '')
      + (day.getTime() === today.getTime() ? ' today' : '');
    el.textContent = dayNum;
    el.disabled = isPast || isBooked;
    el.setAttribute('aria-label', formatShortDate(iso) + (isBooked ? ' — déjà réservé' : ''));
    if (!el.disabled) {
      el.onclick = () => {
        selectedDate = iso;
        selectedDateLabel.value = formatShortDate(iso);
        renderCalendar();
        updateBookingBar();
      };
    }
    calendarGrid.appendChild(el);
  }
}

calPrev.addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});

calNext.addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});

function renderBookings() {
  bookingsWrap.innerHTML = '';
  if (bookings.length === 0) {
    bookingsWrap.innerHTML = '<div class="empty-state">Aucune réservation enregistrée pour le moment.</div>';
    return;
  }
  bookings.forEach(booking => {
    const property = properties.find(p => p.id === booking.propertyId);
    const address = property ? `${property.street}, ${property.city}` : (booking.propertyAddress || 'Bien supprimé');
    const card = document.createElement('div');
    card.className = 'dossier' + (booking.status === 'cancelled' ? ' cancelled' : '');
    card.innerHTML = `
      <div class="dossier-top">
        <div>
          <div class="dossier-addr"></div>
          <div class="dossier-meta">${formatShortDate(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}${booking.linenRequested ? ' · + linge' : ''}</div>
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
        note.textContent = 'Le contrôle qualité a demandé une correction au prestataire — votre ménage sera re-vérifié avant confirmation.';
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
      cancelBtn.onclick = async () => {
        if (!window.confirm(`Annuler le ménage du ${formatShortDate(booking.scheduledDate)} ?`)) return;
        try {
          await withButtonLoading(cancelBtn, () =>
            updateDoc(doc(db, 'bookings', booking.id), { status: 'cancelled' }));
          queueEmail({
            to: TEAM_EMAIL,
            subject: `Kleining — réservation annulée · Réf ${booking.id.slice(0, 6).toUpperCase()}`,
            text: `${address} · ${formatShortDate(booking.scheduledDate)} · annulée par le client ${currentUser.email}.`,
          });
          setAppStatus('Réservation annulée. La date est de nouveau disponible.', 'success');
        } catch (err) {
          setAppStatus('Impossible d’annuler : la mission vient peut-être d’être acceptée par un prestataire. Contactez l’équipe Kleining.', 'error');
        }
      };
      card.appendChild(cancelBtn);
    }
    bookingsWrap.appendChild(card);
  });
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
    if (!selectedPropertyId && properties.length > 0) {
      selectedPropertyId = properties[0].id;
    }
    renderPropertyButtons();
    renderCalendar();
    updateBookingBar();
    updateOnboardingState();
    renderBookings();
  }, () => setAppStatus('Impossible de charger vos biens.', 'error'));

  const bookingsQuery = query(collection(db, 'bookings'), where('clientId', '==', currentUser.uid));
  bookingsUnsub = onSnapshot(bookingsQuery, snapshot => {
    bookings = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
    renderBookings();
    renderCalendar();
    updateOnboardingState();
  }, () => setAppStatus('Impossible de charger vos réservations.', 'error'));
}

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
  selectedPropertyId = null;
  selectedDate = null;
  linenRequested = false;
  properties = [];
  bookings = [];
});

serviceRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    selectedServiceType = radio.value;
    updateBookingBar();
  });
});

linenToggle.addEventListener('change', () => {
  linenRequested = linenToggle.checked;
});

propertyForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser) return;
  const street = propertyStreet.value.trim();
  const city = propertyCity.value.trim();
  const postalCode = propertyPostal.value.trim();
  const notes = propertyNotes.value.trim();
  if (!street || !city || !postalCode) {
    setAppStatus('Veuillez renseigner l’adresse complète du bien.', 'error');
    return;
  }
  try {
    await withButtonLoading(propertyForm.querySelector('button[type="submit"]'), () =>
      addDoc(collection(db, 'properties'), {
        ownerId: currentUser.uid,
        street,
        city,
        postalCode,
        notes,
        createdAt: serverTimestamp(),
      }));
    propertyForm.reset();
    setAppStatus('Bien ajouté. Vous pouvez réserver maintenant.', 'success');
  } catch (err) {
    setAppStatus('Impossible d’ajouter le bien.', 'error');
  }
});

bookBtn.addEventListener('click', async () => {
  if (!currentUser || !selectedPropertyId || !selectedDate) return;
  const property = properties.find(p => p.id === selectedPropertyId);
  if (!property) return;
  const bookedDate = selectedDate;
  try {
    await withButtonLoading(bookBtn, () =>
      addDoc(collection(db, 'bookings'), {
        clientId: currentUser.uid,
        propertyId: selectedPropertyId,
        propertyAddress: `${property.street}, ${property.city}`,
        prestataireId: null,
        serviceType: selectedServiceType,
        price: formatPrice(selectedServiceType),
        scheduledDate: selectedDate,
        status: 'pending',
        linenRequested,
        createdAt: serverTimestamp(),
      }));
    queueEmail({
      to: TEAM_EMAIL,
      subject: `Kleining — nouvelle réservation · ${property.street}, ${property.city}`,
      text: `${formatShortDate(bookedDate)} · ${selectedServiceType === 'deep' ? 'Nettoyage en profondeur (60€)' : 'Nettoyage normal (47€)'}${linenRequested ? ' · option linge' : ''} · client : ${currentUser.email}`,
    });
    setAppStatus('Réservation enregistrée. Vous serez notifié par email une fois le ménage vérifié par l’équipe Kleining.', 'success');
    selectedDate = null;
    selectedDateLabel.value = 'Aucune date';
    renderCalendar();
    updateBookingBar();
  } catch (err) {
    setAppStatus('Impossible d’enregistrer la réservation.', 'error');
  }
});

updateBookingBar();
