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
} from './shared.js';
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

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

let currentUser = null;
let selectedPropertyId = null;
let selectedDate = null;
let selectedServiceType = 'normal';
let linenRequested = false;
let properties = [];
let bookings = [];
let propertiesUnsub = null;
let bookingsUnsub = null;

function showAuth(mode = 'signin', message = '') {
  authScreen.classList.remove('hidden');
  appScreen.classList.add('hidden');
  signInForm.classList.toggle('hidden', mode !== 'signin');
  registerForm.classList.toggle('hidden', mode !== 'register');
  authTitle.textContent = mode === 'signin' ? 'Connexion client' : 'Créer un compte client';
  authError.textContent = message;
  authError.classList.toggle('hidden', !message);
}

function showApp() {
  authScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  authError.textContent = '';
  authError.classList.add('hidden');
  userNameLabel.textContent = currentUser.name || currentUser.email;
}

function setAppStatus(text) {
  appStatus.textContent = text;
  appStatus.classList.toggle('hidden', !text);
}

function updateBookingBar() {
  const price = formatPrice(selectedServiceType);
  // TODO: confirm with team — le linge est-il facturé en plus des deux forfaits ?
  priceValue.textContent = `${price}€`;
  bookBtn.textContent = selectedDate ? `Réserver le ${formatShortDate(selectedDate)} — ${price}€` : 'Choisir une date pour réserver';
  bookBtn.disabled = !selectedPropertyId || !selectedDate;
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
  ['L', 'M', 'M', 'J', 'V', 'S', 'D'].forEach(label => {
    const div = document.createElement('div');
    div.className = 'cal-day-label';
    div.textContent = label;
    calendarGrid.appendChild(div);
  });
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const takenDates = bookings
    .filter(b => b.propertyId === selectedPropertyId && b.status !== 'rejected')
    .map(b => b.scheduledDate);
  for (let offset = 0; offset < 28; offset += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const isBooked = takenDates.includes(iso);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cal-day' + (isBooked ? ' booked' : '') + (selectedDate === iso ? ' selected' : '') + (offset === 0 ? ' today' : '');
    el.textContent = day.getDate();
    el.disabled = isBooked;
    if (!isBooked) {
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
    card.className = 'dossier';
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
  }, () => setAppStatus('Impossible de charger vos biens.'));

  const bookingsQuery = query(collection(db, 'bookings'), where('clientId', '==', currentUser.uid));
  bookingsUnsub = onSnapshot(bookingsQuery, snapshot => {
    bookings = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
    renderBookings();
    renderCalendar();
  }, () => setAppStatus('Impossible de charger vos réservations.'));
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    if (propertiesUnsub) propertiesUnsub();
    if (bookingsUnsub) bookingsUnsub();
    showAuth('signin');
    return;
  }
  try {
    const docData = await loadUserDoc(user.uid);
    if (!docData) {
      await signOut(auth);
      showAuth('register', 'Compte introuvable. Veuillez créer un compte client.');
      return;
    }
    if (docData.role !== ROLE_CLIENT) {
      await signOut(auth);
      showAuth('signin', 'Ce compte n’est pas autorisé sur l’interface client.');
      return;
    }
    currentUser = { uid: user.uid, ...docData };
    showApp();
    subscribeData();
  } catch (error) {
    await signOut(auth);
    showAuth('signin', authErrorMessage(error));
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
    await signInWithEmailAndPassword(auth, email, password);
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
    await registerClient({ name, email, password, phone });
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
    setAppStatus('Veuillez renseigner l’adresse complète du bien.');
    return;
  }
  try {
    await addDoc(collection(db, 'properties'), {
      ownerId: currentUser.uid,
      street,
      city,
      postalCode,
      notes,
      createdAt: serverTimestamp(),
    });
    propertyForm.reset();
    setAppStatus('Bien ajouté. Vous pouvez réserver maintenant.');
  } catch (err) {
    setAppStatus('Impossible d’ajouter le bien.');
  }
});

bookBtn.addEventListener('click', async () => {
  if (!currentUser || !selectedPropertyId || !selectedDate) return;
  const property = properties.find(p => p.id === selectedPropertyId);
  if (!property) return;
  try {
    await addDoc(collection(db, 'bookings'), {
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
    });
    setAppStatus('Réservation enregistrée. Vous serez notifié une fois le ménage vérifié par l’équipe Kleining.');
    selectedDate = null;
    selectedDateLabel.value = 'Aucune date';
    renderCalendar();
    updateBookingBar();
  } catch (err) {
    setAppStatus('Impossible d’enregistrer la réservation.');
  }
});

updateBookingBar();
