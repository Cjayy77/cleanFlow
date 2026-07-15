import { auth, db, ROLE_CLIENT, createOrUpdateUserDoc, loadUserDoc, formatPrice } from './shared.js';
import { collection, query, where, orderBy, onSnapshot, addDoc, updateDoc, doc, getDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { onAuthStateChanged, signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

const authScreen = document.getElementById('authScreen');
const appScreen = document.getElementById('appScreen');
const authError = document.getElementById('authError');
const formSwitch = document.getElementById('formSwitch');
const authTitle = document.getElementById('authTitle');
const signInForm = document.getElementById('signInForm');
const registerForm = document.getElementById('registerForm');
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
  authScreen.style.display = 'block';
  appScreen.style.display = 'none';
  signInForm.style.display = mode === 'signin' ? 'block' : 'none';
  registerForm.style.display = mode === 'register' ? 'block' : 'none';
  formSwitch.textContent = mode === 'signin' ? 'Créer un compte client' : 'Se connecter';
  authTitle.textContent = mode === 'signin' ? 'Connexion client' : 'Enregistrement client';
  authError.textContent = message;
  authError.classList.toggle('hidden', !message);
}

function showApp() {
  authScreen.style.display = 'none';
  appScreen.style.display = 'block';
  authError.textContent = '';
  authError.classList.add('hidden');
  userNameLabel.textContent = currentUser.name || currentUser.email;
}

function setAppStatus(text) {
  appStatus.textContent = text;
  appStatus.classList.toggle('hidden', !text);
}

async function createClientUser(email, password, name, phone) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  const userDoc = await createOrUpdateUserDoc(credential.user, ROLE_CLIENT, { name, phone });
  return userDoc;
}

function updateBookingStatusVisibility() {
  const price = selectedServiceType === 'deep' ? 60 : 47;
  priceValue.textContent = `${price}€`;
  bookBtn.textContent = selectedDate ? `Réserver le ${selectedDate} — ${price}€` : 'Choisir une date pour réserver';
  bookBtn.disabled = !selectedPropertyId || !selectedDate;
}

function formatDateLabel(isoDate) {
  const date = new Date(isoDate);
  return date.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });
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
    button.innerHTML = `<div class="p-thumb"></div><div><div class="p-name">${prop.street}, ${prop.city}</div><div class="p-meta">${prop.postalCode}</div></div>`;
    button.onclick = () => {
      selectedPropertyId = prop.id;
      selectedDate = null;
      renderCalendar();
      updateBookingStatusVisibility();
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
  const activePropertyBookings = bookings.filter(b => b.propertyId === selectedPropertyId).map(b => b.scheduledDate);
  for (let offset = 0; offset < 28; offset += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    const iso = day.toISOString().slice(0, 10);
    const isBooked = activePropertyBookings.includes(iso);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cal-day' + (isBooked ? ' booked' : '') + (selectedDate === iso ? ' selected' : '');
    el.textContent = day.getDate();
    if (!isBooked) {
      el.onclick = () => {
        selectedDate = iso;
        selectedDateLabel.textContent = formatDateLabel(iso);
        renderCalendar();
        updateBookingStatusVisibility();
      };
    }
    if (day.toDateString() === today.toDateString()) {
      el.style.border = '1px solid var(--klein)';
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
  bookings.sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
  bookings.forEach(booking => {
    const property = properties.find(p => p.id === booking.propertyId);
    const card = document.createElement('div');
    card.className = 'dossier';
    card.innerHTML = `
      <div class="dossier-top">
        <div>
          <div class="dossier-addr">${property ? `${property.street}, ${property.city}` : 'Bien supprimé'}</div>
          <div class="dossier-meta">${formatDateLabel(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}${booking.linenRequested ? ' · + linge' : ''}</div>
        </div>
        <div class="status-pill ${booking.status}">${booking.status === 'pending' ? 'En attente' : booking.status === 'accepted' ? 'Accepté' : booking.status === 'submitted' ? 'Photos soumises' : booking.status === 'verified' ? 'Confirmé' : booking.status === 'rejected' ? 'Rejeté' : booking.status}</div>
      </div>
      <div class="dossier-meta">${booking.price}€ · Réf ${booking.id.slice(0, 6).toUpperCase()}</div>
    `;
    bookingsWrap.appendChild(card);
  });
}

async function subscribeData() {
  if (!currentUser) return;

  if (propertiesUnsub) propertiesUnsub();
  if (bookingsUnsub) bookingsUnsub();

  const propsQuery = query(collection(db, 'properties'), where('ownerId', '==', currentUser.uid), orderBy('street'));
  propertiesUnsub = onSnapshot(propsQuery, snapshot => {
    properties = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    if (!selectedPropertyId && properties.length > 0) {
      selectedPropertyId = properties[0].id;
      selectedDate = null;
    }
    renderPropertyButtons();
    renderCalendar();
    updateBookingStatusVisibility();
  }, error => {
    setAppStatus('Impossible de charger vos biens.');
  });

  const bookingsQuery = query(collection(db, 'bookings'), where('clientId', '==', currentUser.uid), orderBy('scheduledDate', 'asc'));
  bookingsUnsub = onSnapshot(bookingsQuery, snapshot => {
    bookings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderBookings();
    renderCalendar();
  }, error => {
    setAppStatus('Impossible de charger vos réservations.');
  });
}

async function ensureClientRole(user) {
  const docData = await loadUserDoc(user.uid);
  if (!docData) {
    return null;
  }
  if (docData.role !== ROLE_CLIENT) {
    throw new Error('Ce compte n’est pas autorisé sur l’interface client.');
  }
  return docData;
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    showAuth('signin');
    return;
  }
  try {
    const docData = await ensureClientRole(user);
    if (!docData) {
      signOut(auth);
      showAuth('register', 'Compte introuvable. Veuillez créer un compte client.');
      return;
    }
    currentUser = { uid: user.uid, ...docData };
    showApp();
    await subscribeData();
  } catch (error) {
    authError.textContent = error.message;
    await signOut(auth);
    showAuth('signin');
  }
});

formSwitch.addEventListener('click', () => {
  const mode = registerForm.style.display === 'block' ? 'signin' : 'register';
  showAuth(mode);
});

signInForm.addEventListener('submit', async event => {
  event.preventDefault();
  authError.textContent = '';
  const email = document.getElementById('signInEmail').value.trim();
  const password = document.getElementById('signInPassword').value;
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const docData = await ensureClientRole(credential.user);
    if (!docData) {
      throw new Error('Votre compte existe mais n’est pas un compte client.');
    }
  } catch (err) {
    authError.textContent = err.message;
  }
});

registerForm.addEventListener('submit', async event => {
  event.preventDefault();
  authError.textContent = '';
  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value;
  const name = document.getElementById('registerName').value.trim();
  const phone = document.getElementById('registerPhone').value.trim();
  try {
    await createClientUser(email, password, name, phone);
  } catch (err) {
    authError.textContent = err.message;
  }
});

signOutBtn.addEventListener('click', async () => {
  await signOut(auth);
  currentUser = null;
  selectedPropertyId = null;
  selectedDate = null;
  linenRequested = false;
  properties = [];
  bookings = [];
  showAuth('signin');
});

serviceRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    selectedServiceType = radio.value;
    updateBookingStatusVisibility();
  });
});

linenToggle.addEventListener('change', () => {
  linenRequested = linenToggle.checked;
  updateBookingStatusVisibility();
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
    propertyStreet.value = '';
    propertyCity.value = '';
    propertyPostal.value = '';
    propertyNotes.value = '';
    setAppStatus('Bien ajouté. Vous pouvez réserver maintenant.');
  } catch (err) {
    setAppStatus('Impossible d’ajouter le bien.');
  }
});

bookBtn.addEventListener('click', async () => {
  if (!currentUser || !selectedPropertyId || !selectedDate) return;
  const price = formatPrice(selectedServiceType);
  try {
    await addDoc(collection(db, 'bookings'), {
      clientId: currentUser.uid,
      propertyId: selectedPropertyId,
      prestataireId: null,
      serviceType: selectedServiceType,
      price,
      scheduledDate: selectedDate,
      status: 'pending',
      linenRequested,
      createdAt: serverTimestamp(),
    });
    setAppStatus('Réservation enregistrée. Un prestataire pourra l’accepter à partir du tableau de bord.');
    selectedDate = null;
    renderCalendar();
    updateBookingStatusVisibility();
  } catch (err) {
    setAppStatus('Impossible d’enregistrer la réservation.');
  }
});

updateBookingStatusVisibility();

export {};
