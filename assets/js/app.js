// CleanFlow — espace client : biens, calendrier de réservation, historique.
import {
  auth,
  db,
  ROLE_CLIENT,
  loadUserDoc,
  registerClient,
  computeBookingPrice,
  setPricing,
  openDevisDocument,
  WELCOMER_TIERS,
  welcomerTier,
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
const propertySurface = document.getElementById('propertySurface');
const propertyZone = document.getElementById('propertyZone');
const propertyNotes = document.getElementById('propertyNotes');
const propertyKeyAccess = document.getElementById('propertyKeyAccess');
const propertyFormTitle = document.getElementById('propertyFormTitle');
const propertySubmitBtn = document.getElementById('propertySubmitBtn');
const cancelEditWrap = document.getElementById('cancelEditWrap');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const propertyFormCard = document.getElementById('propertyFormCard');
const bedroomsInput = document.getElementById('bedrooms');
const bedsInput = document.getElementById('beds');
const bathroomsInput = document.getElementById('bathrooms');
const guestsInput = document.getElementById('guests');
const propertyTypeInput = document.getElementById('propertyType');
const supplementsCard = document.getElementById('supplementsCard');
const supplementsList = document.getElementById('supplementsList');
const welcomerSelect = document.getElementById('welcomerService');
if (welcomerSelect) {
  welcomerSelect.innerHTML = '<option value="">Sans Welcomer</option>'
    + WELCOMER_TIERS.map(t => `<option value="${t.key}">${t.label} — ${t.fee}€ HT</option>`).join('');
}

const CATALOG_LABELS = { service: 'Prestations', kit: "Kits d'accueil", consumable: 'Consommables', linen: 'Location de linge' };
const priceBreakdown = document.getElementById('priceBreakdown');
const appStatus = document.getElementById('appStatus');
const welcomeText = document.getElementById('welcomeText');
const bookingCard = document.getElementById('bookingCard');
const historyCard = document.getElementById('historyCard');
const bookingFor = document.getElementById('bookingFor');

// Étapes affichées au client — la transparence du process est la promesse
// centrale de CleanFlow.
const BOOKING_STEPS = ['Réservée', 'Prise en charge', 'Ménage + photos', 'Confirmée'];
const STATUS_STEP = { pending: 0, accepted: 1, submitted: 2, rejected: 2, verified: 3 };

let currentUser = null;
let selectedPropertyId = null;
let selectedDate = null;
let selectedServiceType = 'normal';
let welcomerService = '';
let beds = 1;
let bathrooms = 1;
let guests = 0;
let propertyType = 'appartement';
let bedrooms = 0;
let properties = [];
let bookings = [];
let propertiesUnsub = null;
let bookingsUnsub = null;
let pricingUnsub = null;
let catalogUnsub = null;
let catalog = [];
let selectedExtras = {}; // { itemId: quantité }
let authNotice = null;
let editingPropertyId = null;
let calendarMonth = startOfMonth(new Date());

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
  propertyFormTitle.textContent = property ? 'Modifier la propriété' : 'Ajouter une propriété';
  propertySubmitBtn.textContent = property ? 'Enregistrer les modifications' : 'Enregistrer le bien';
  cancelEditWrap.classList.toggle('hidden', !property);
  propertyStreet.value = property ? property.street : '';
  propertyCity.value = property ? property.city : '';
  propertyPostal.value = property ? property.postalCode : '';
  propertySurface.value = property && property.surface ? property.surface : '';
  propertyZone.value = property && property.zone ? property.zone : (ZONES[0] ? ZONES[0].value : '');
  propertyNotes.value = property ? (property.notes || '') : '';
  if (propertyKeyAccess) propertyKeyAccess.value = property ? (property.keyAccess || '') : '';
  if (property) {
    propertyForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    propertyStreet.focus();
  }
}

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

// Détail de prix courant, recalculé à chaque changement (bien, service, kits).
let currentQuote = null;

function updateBookingBar() {
  const property = properties.find(p => p.id === selectedPropertyId);
  bookingFor.textContent = property ? `Pour : ${property.street}, ${property.city}` : '';
  currentQuote = property
    ? computeBookingPrice({ surface: property.surface, serviceType: selectedServiceType, beds, bathrooms, bedrooms, zone: property.zone })
    : null;

  // Bien sans surface renseignée (ancien bien) : inviter à compléter.
  if (property && !currentQuote) {
    priceBreakdown.classList.remove('hidden');
    priceBreakdown.innerHTML = '<div class="pb-line pb-warn">Renseignez la surface de ce bien (Modifier) pour calculer le prix.</div>';
    priceValue.textContent = '—';
    bookBtn.textContent = 'Surface du bien manquante';
    bookBtn.disabled = true;
    return;
  }

  // Surface > 250 m² : tarif sur-mesure, on propose une demande de devis.
  if (currentQuote && currentQuote.custom) {
    priceBreakdown.classList.remove('hidden');
    priceBreakdown.innerHTML = '<div class="pb-line pb-warn">Surface supérieure à 250&nbsp;m² : tarif sur-mesure. Demandez un devis à l’équipe.</div>';
    priceValue.textContent = 'Sur devis';
    bookBtn.textContent = selectedDate ? 'Demander un devis' : 'Choisir une date pour le devis';
    bookBtn.disabled = !selectedDate;
    return;
  }

  const extras = currentQuote ? selectedExtrasList() : [];
  const extrasHT = extras.reduce((s, e) => s + e.lineHT, 0);
  const wf = welcomerFeeValue();
  renderPriceBreakdown(currentQuote, extras, wf);
  let ttc = null;
  if (currentQuote) {
    const finalHT = currentQuote.total + extrasHT + wf;
    ttc = finalHT + Math.round(finalHT * currentQuote.vatRate);
  }
  priceValue.textContent = ttc != null ? `${ttc}€` : '—';
  bookBtn.textContent = selectedDate && ttc != null
    ? `Réserver le ${formatShortDate(selectedDate)} · ${ttc}€`
    : 'Choisir une date pour réserver';
  bookBtn.disabled = !selectedPropertyId || !selectedDate || ttc == null;
}

function welcomerFeeValue() {
  const t = welcomerTier(welcomerService);
  return t ? t.fee : 0;
}

function renderPriceBreakdown(quote, extras, welcomerFee) {
  if (!quote || quote.custom) { priceBreakdown.classList.add('hidden'); return; }
  extras = extras || [];
  welcomerFee = welcomerFee || 0;
  const extrasHT = extras.reduce((s, e) => s + e.lineHT, 0);
  const finalHT = quote.total + extrasHT + welcomerFee;
  const vat = Math.round(finalHT * quote.vatRate);
  const h = String(quote.hours).replace('.', ',');
  const rows = [
    [`Ménage ${quote.serviceType === 'deep' ? 'approfondi' : 'standard'} · ${h} h × ${quote.hourlyRate}€/h`, `${quote.prestation}€`, ''],
  ];
  if (quote.kitCount > 0) rows.push([`Kits de bienvenue · ${quote.kitCount} chambre${quote.kitCount > 1 ? 's' : ''}`, `${quote.kitsTotal}€`, '']);
  extras.forEach(e => rows.push([`${e.name}${e.qty > 1 ? ` × ${e.qty}` : ''}`, `${e.lineHT}€`, '']));
  if (welcomerFee) { const t = welcomerTier(welcomerService); rows.push([`Welcomer · ${t ? t.label : 'validation'}`, `${welcomerFee}€`, '']); }
  if (quote.commission) rows.push(['Commission CleanFlow', `${quote.commission}€`, '']);
  rows.push(['Frais de déplacement', `${quote.travel}€`, '']);
  rows.push(['Total HT', `${finalHT}€`, 'pb-total']);
  rows.push([`TVA (${Math.round(quote.vatRate * 100)} %)`, `${vat}€`, '']);
  priceBreakdown.classList.remove('hidden');
  priceBreakdown.innerHTML = rows
    .map(([label, value, cls]) => `<div class="pb-line ${cls}"><span></span><b>${value}</b></div>`)
    .join('');
  // Remplit les libellés en texte (évite l'injection HTML depuis les données).
  priceBreakdown.querySelectorAll('.pb-line span').forEach((span, index) => {
    span.textContent = rows[index][0];
  });
}

// Divulgation progressive : tant qu'aucun bien n'est enregistré, on ne montre
// que l'étape utile (ajouter un bien) au lieu de tout l'écran d'un coup.
function updateOnboardingState() {
  const hasProperties = properties.length > 0;
  const hasBookings = bookings.length > 0;
  bookingCard.classList.toggle('hidden', !hasProperties);
  historyCard.classList.toggle('hidden', !hasProperties && !hasBookings);
  if (!hasProperties) propertyFormCard.open = true;
  if (!hasProperties) {
    welcomeText.textContent = 'Bienvenue ! Première étape : enregistrez votre bien ci-dessous. Vous pourrez ensuite réserver votre premier ménage sur son calendrier.';
  } else if (!hasBookings) {
    welcomeText.textContent = 'Votre bien est enregistré. Choisissez une date sur le calendrier, le prix est affiché avant confirmation.';
  } else {
    welcomeText.textContent = 'Réservez un ménage, suivez sa vérification par l’équipe CleanFlow, et recevez la confirmation une fois le contrôle photo effectué.';
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
    const row = document.createElement('div');
    row.className = 'property-card' + (selectedPropertyId === prop.id ? ' selected' : '');

    const selectBtn = document.createElement('button');
    selectBtn.className = 'property-select';
    selectBtn.type = 'button';
    const name = document.createElement('div');
    name.className = 'p-name';
    name.textContent = `${prop.street}, ${prop.city}`;
    const meta = document.createElement('div');
    meta.className = 'p-meta';
    meta.textContent = [prop.postalCode, prop.surface ? `${prop.surface} m²` : null, zoneLabel(prop.zone)]
      .filter(Boolean).join(' · ');
    const text = document.createElement('div');
    text.appendChild(name);
    text.appendChild(meta);
    selectBtn.appendChild(text);
    selectBtn.setAttribute('aria-label', `Sélectionner ${prop.street}, ${prop.city}`);
    selectBtn.onclick = () => {
      selectedPropertyId = prop.id;
      selectedDate = null;
      selectedDateLabel.value = 'Aucune date';
      renderCalendar();
      updateBookingBar();
      renderPropertyButtons();
    };

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
        if (selectedPropertyId === prop.id) {
          selectedPropertyId = null;
          selectedDate = null;
          selectedDateLabel.value = 'Aucune date';
        }
        if (editingPropertyId === prop.id) setPropertyFormMode(null);
        setAppStatus('Bien supprimé.', 'success');
      } catch (err) {
        setAppStatus(`Impossible de supprimer le bien : ${authErrorMessage(err)}`, 'error');
      }
    }, () => {
      const hasActiveBooking = bookings.some(b => b.propertyId === prop.id && ACTIVE_BOOKING_STATUSES.includes(b.status));
      if (hasActiveBooking) {
        setAppStatus('Impossible de supprimer ce bien : une réservation est en cours. Annulez-la d’abord ou attendez sa confirmation.', 'error');
        return false;
      }
      return true;
    });
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    row.appendChild(selectBtn);
    row.appendChild(actions);
    propertyList.appendChild(row);
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
  // Les plus récentes d'abord ; les annulées reléguées en bas — pour garder
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
      armInlineConfirm(cancelBtn, 'Confirmer l’annulation', async () => {
        try {
          await withButtonLoading(cancelBtn, () =>
            withTimeout(updateDoc(doc(db, 'bookings', booking.id), { status: 'cancelled' }), 15000));
          queueEmail({
            to: TEAM_EMAIL,
            subject: `CleanFlow — réservation annulée · Réf ${booking.id.slice(0, 6).toUpperCase()}`,
            text: `${address} · ${formatShortDate(booking.scheduledDate)} · annulée par le client ${currentUser.email}.`,
          });
          setAppStatus('Réservation annulée. La date est de nouveau disponible.', 'success');
        } catch (err) {
          setAppStatus('Impossible d’annuler : la mission vient peut-être d’être acceptée par un prestataire. Contactez l’équipe CleanFlow.', 'error');
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
  textarea.placeholder = 'Votre message à l’équipe CleanFlow (question, problème constaté, suite d’un incident…).';
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
        subject: `CleanFlow — message client · Réf ${booking.id.slice(0, 6).toUpperCase()}`,
        text: `${currentUser.name || currentUser.email} (${currentUser.email}) à propos de ${address} (${formatShortDate(booking.scheduledDate)}) :\n\n${text}`,
      });
      textarea.value = '';
      form.classList.add('hidden');
      setAppStatus('Message envoyé à l’équipe CleanFlow. Vous serez recontacté par email ou téléphone.', 'success');
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

// Charge la grille tarifaire définie par l'admin (back-office). En cas d'absence
// ou d'erreur, le calcul retombe sur les valeurs par défaut (setPricing est
// défensif). Live : une modification admin recalcule le prix affiché.
function subscribePricing() {
  if (pricingUnsub) pricingUnsub();
  pricingUnsub = onSnapshot(doc(db, 'settings', 'pricing'), snap => {
    if (snap.exists()) setPricing(snap.data());
    updateBookingBar();
  }, () => { /* défauts déjà en place */ });
}

// Catalogue (kits, consommables, linge) proposé en supplément à la réservation.
function subscribeCatalog() {
  if (catalogUnsub) catalogUnsub();
  catalogUnsub = onSnapshot(collection(db, 'catalog'), snap => {
    catalog = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(i => i.active !== false);
    renderSupplements();
    updateBookingBar();
  }, () => { /* catalogue indisponible : on masque simplement les suppléments */ });
}

// Liste des suppléments sélectionnés (quantité > 0), avec le détail de ligne.
function selectedExtrasList() {
  return catalog
    .filter(i => (selectedExtras[i.id] || 0) > 0)
    .map(i => {
      const qty = selectedExtras[i.id];
      const priceHT = Number(i.priceHT) || 0;
      return { id: i.id, name: i.name || '', type: i.type || '', priceHT, priceTTC: Number(i.priceTTC) || 0, qty, lineHT: priceHT * qty };
    });
}

function renderSupplements() {
  if (!supplementsCard || !supplementsList) return;
  if (!catalog.length) { supplementsCard.classList.add('hidden'); return; }
  supplementsCard.classList.remove('hidden');
  supplementsList.innerHTML = '';
  ['service', 'kit', 'consumable', 'linen'].forEach(type => {
    const items = catalog.filter(i => i.type === type).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!items.length) return;
    const head = document.createElement('div');
    head.className = 'p-meta';
    head.style.cssText = 'text-transform:uppercase;letter-spacing:0.06em;margin:12px 0 4px;';
    head.textContent = CATALOG_LABELS[type] || type;
    supplementsList.appendChild(head);
    items.forEach(item => supplementsList.appendChild(supplementRow(item)));
  });
}

function supplementRow(item) {
  const row = document.createElement('div');
  row.className = 'supp-row';
  const info = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'supp-name';
  name.textContent = item.name || '(sans nom)';
  const auto = item.unit === 'bed' || item.unit === 'guest';
  const per = item.unit === 'bed' ? 'lit' : 'voyageur';
  const basis = item.unit === 'bed' ? beds : guests;
  const meta = document.createElement('div');
  meta.className = 'p-meta';
  meta.textContent = `${Number(item.priceTTC) || 0}€ TTC / ${auto ? per : 'unité'}`;
  info.append(name, meta);

  if (auto) {
    // Quantité calculée automatiquement selon le nombre de lits / voyageurs.
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;white-space:nowrap;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.cssText = 'width:auto;';
    cb.checked = (selectedExtras[item.id] || 0) > 0;
    const hint = document.createElement('span');
    hint.textContent = `× ${basis} ${per}${basis > 1 ? 's' : ''}`;
    cb.addEventListener('change', () => {
      if (cb.checked && basis > 0) selectedExtras[item.id] = basis; else delete selectedExtras[item.id];
      updateBookingBar();
    });
    wrap.append(cb, hint);
    row.append(info, wrap);
  } else {
    const qty = document.createElement('input');
    qty.type = 'number';
    qty.min = '0';
    qty.step = '1';
    qty.className = 'supp-qty';
    qty.value = selectedExtras[item.id] || 0;
    qty.setAttribute('aria-label', `Quantité — ${item.name || ''}`);
    qty.addEventListener('input', () => {
      const n = Math.max(0, Math.floor(Number(qty.value) || 0));
      if (n > 0) selectedExtras[item.id] = n; else delete selectedExtras[item.id];
      updateBookingBar();
    });
    row.append(info, qty);
  }
  return row;
}

// Recalcule la quantité des suppléments « par lit / par voyageur » cochés.
function resyncAutoExtras() {
  catalog.forEach(i => {
    if ((i.unit === 'bed' || i.unit === 'guest') && (selectedExtras[i.id] || 0) > 0) {
      const basis = i.unit === 'bed' ? beds : guests;
      if (basis > 0) selectedExtras[i.id] = basis; else delete selectedExtras[i.id];
    }
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
  }, error => setAppStatus(`Impossible de charger vos biens : ${authErrorMessage(error)}`, 'error'));

  const bookingsQuery = query(collection(db, 'bookings'), where('clientId', '==', currentUser.uid));
  bookingsUnsub = onSnapshot(bookingsQuery, snapshot => {
    bookings = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
    renderBookings();
    renderCalendar();
    updateOnboardingState();
  }, error => setAppStatus(`Impossible de charger vos réservations : ${authErrorMessage(error)}`, 'error'));
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    if (propertiesUnsub) propertiesUnsub();
    if (bookingsUnsub) bookingsUnsub();
    if (pricingUnsub) pricingUnsub();
    if (catalogUnsub) catalogUnsub();
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
    subscribePricing();
    subscribeCatalog();
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
  bedrooms = 0;
  properties = [];
  bookings = [];
});

serviceRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    selectedServiceType = radio.value;
    updateBookingBar();
  });
});

bedroomsInput.addEventListener('input', () => {
  bedrooms = Math.max(0, Math.floor(Number(bedroomsInput.value) || 0));
  updateBookingBar();
});

if (welcomerSelect) {
  welcomerSelect.addEventListener('change', () => {
    welcomerService = welcomerSelect.value;
    updateBookingBar();
  });
}

bedsInput.addEventListener('input', () => {
  beds = Math.max(1, Math.floor(Number(bedsInput.value) || 1));
  resyncAutoExtras();
  renderSupplements();
  updateBookingBar();
});

bathroomsInput.addEventListener('input', () => {
  bathrooms = Math.max(1, Math.floor(Number(bathroomsInput.value) || 1));
  updateBookingBar();
});

guestsInput.addEventListener('input', () => {
  guests = Math.max(0, Math.floor(Number(guestsInput.value) || 0));
  resyncAutoExtras();
  renderSupplements();
  updateBookingBar();
});

propertyTypeInput.addEventListener('change', () => {
  propertyType = propertyTypeInput.value;
});

propertyForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser) return;
  const street = propertyStreet.value.trim();
  const city = propertyCity.value.trim();
  const postalCode = propertyPostal.value.trim();
  const surface = Math.floor(Number(propertySurface.value) || 0);
  const zone = propertyZone.value;
  const notes = propertyNotes.value.trim();
  const keyAccess = propertyKeyAccess ? propertyKeyAccess.value.trim() : '';
  if (!street || !city || !postalCode) {
    setAppStatus('Veuillez renseigner l’adresse complète du bien.', 'error');
    return;
  }
  if (!surface || surface <= 0) {
    setAppStatus('Indiquez la surface du bien (en m²) : elle détermine le tarif.', 'error');
    return;
  }
  if (!zone) {
    setAppStatus('Sélectionnez la zone du bien.', 'error');
    return;
  }
  try {
    if (editingPropertyId) {
      const propertyId = editingPropertyId;
      const newAddress = `${street}, ${city}`;
      // Recopie la nouvelle adresse sur les réservations en cours de ce bien
      // pour que prestataire et livreur ne voient jamais l'ancienne.
      const affected = bookings.filter(b => b.propertyId === propertyId && ACTIVE_BOOKING_STATUSES.includes(b.status));
      await withButtonLoading(propertySubmitBtn, () => withTimeout((async () => {
        await updateDoc(doc(db, 'properties', propertyId), { street, city, postalCode, surface, zone, notes, keyAccess });
        await Promise.all(affected.map(b =>
          updateDoc(doc(db, 'bookings', b.id), { propertyAddress: newAddress, keyAccess })));
      })(), 20000));
      setPropertyFormMode(null);
      setAppStatus(affected.length
        ? 'Bien modifié. Les réservations en cours ont été mises à jour.'
        : 'Bien modifié.', 'success');
    } else {
      await withButtonLoading(propertySubmitBtn, () =>
        withTimeout(addDoc(collection(db, 'properties'), {
          ownerId: currentUser.uid,
          street,
          city,
          postalCode,
          surface,
          zone,
          notes,
          keyAccess,
          createdAt: serverTimestamp(),
        }), 15000));
      propertyForm.reset();
      propertyFormCard.open = false;
      setAppStatus('Bien ajouté. Vous pouvez réserver maintenant.', 'success');
    }
  } catch (err) {
    setAppStatus(`Impossible d’enregistrer le bien : ${authErrorMessage(err)}`, 'error');
  }
});

cancelEditBtn.addEventListener('click', event => {
  event.preventDefault();
  setPropertyFormMode(null);
});

bookBtn.addEventListener('click', async () => {
  if (!currentUser || !selectedPropertyId || !selectedDate) return;
  const property = properties.find(p => p.id === selectedPropertyId);
  if (!property) return;
  const bookedDate = selectedDate;
  const quote = computeBookingPrice({ surface: property.surface, serviceType: selectedServiceType, beds, bathrooms, bedrooms, zone: property.zone });
  if (!quote) {
    setAppStatus('Renseignez la surface de ce bien avant de réserver.', 'error');
    return;
  }

  // Sur-mesure (> 250 m²) : pas de réservation directe, on envoie une demande
  // de devis à l'équipe qui reviendra vers le client avec un prix.
  if (quote.custom) {
    const address = `${property.street}, ${property.city}`;
    const devisText = `Demande de devis (sur-mesure, > 250 m²) — ${address} · ${property.surface} m² · ${selectedServiceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'} · ${beds} lit(s) · ${bedrooms} chambre(s) · zone ${zoneLabel(property.zone)} · date souhaitée : ${formatShortDate(bookedDate)}.`;
    try {
      // Trace la demande côté équipe (onglet Messages de l'admin) en plus de l'email.
      await withButtonLoading(bookBtn, () =>
        withTimeout(addDoc(collection(db, 'messages'), {
          bookingId: '',
          clientId: currentUser.uid,
          clientEmail: currentUser.email,
          clientName: currentUser.name || '',
          propertyAddress: address,
          text: devisText,
          status: 'open',
          createdAt: serverTimestamp(),
        }), 15000));
      queueEmail({
        to: TEAM_EMAIL,
        subject: `CleanFlow — demande de devis · ${address}`,
        text: `${devisText} Client : ${currentUser.name || currentUser.email} (${currentUser.email}).`,
      });
      setAppStatus('Demande de devis envoyée à l’équipe CleanFlow. Vous serez recontacté avec un tarif sur-mesure.', 'success');
    } catch (err) {
      setAppStatus(`Impossible d’envoyer la demande de devis : ${authErrorMessage(err)}`, 'error');
    }
    return;
  }

  // Suppléments choisis (kits, consommables, linge) : ajoutés au total HT.
  const extras = selectedExtrasList().map(e => ({
    id: e.id, name: e.name, type: e.type, priceHT: e.priceHT, priceTTC: e.priceTTC, qty: e.qty,
  }));
  const extrasHT = extras.reduce((s, e) => s + e.priceHT * e.qty, 0);
  const wFee = welcomerFeeValue();
  const finalHT = quote.total + extrasHT + wFee;

  try {
    await withButtonLoading(bookBtn, () =>
      withTimeout(addDoc(collection(db, 'bookings'), {
        clientId: currentUser.uid,
        propertyId: selectedPropertyId,
        propertyAddress: `${property.street}, ${property.city}`,
        keyAccess: property.keyAccess || '',
        prestataireId: null,
        livreurId: null,
        serviceType: quote.serviceType,
        surface: Number(property.surface),
        zone: property.zone || '',
        propertyType,
        beds: quote.beds,
        bathrooms: quote.bathrooms,
        guests,
        hours: quote.hours,
        bedrooms: quote.bedrooms,
        kitCount: quote.kitCount,
        prestationPrice: quote.prestation,
        amenitiesPrice: quote.amenitiesTotal,
        travelFee: quote.travel,
        commission: quote.commission,
        extras,
        extrasHT,
        welcomerService: welcomerService || '',
        welcomerFee: wFee,
        welcomerId: null,
        price: finalHT,
        scheduledDate: selectedDate,
        status: 'pending',
        linenRequested: quote.kitCount > 0,
        createdAt: serverTimestamp(),
      }), 15000));
    queueEmail({
      to: TEAM_EMAIL,
      subject: `CleanFlow — nouvelle réservation · ${property.street}, ${property.city}`,
      text: `${formatShortDate(bookedDate)} · ${quote.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'} · ${property.surface} m² · ${quote.kitCount} chambre(s)/kit(s) · total ${quote.total}€ · zone ${zoneLabel(property.zone)} · client : ${currentUser.email}`,
    });
    setAppStatus('Réservation enregistrée. Vous serez notifié par email une fois le ménage vérifié par l’équipe CleanFlow.', 'success');
    selectedDate = null;
    selectedDateLabel.value = 'Aucune date';
    bedrooms = 0;
    if (bedroomsInput) bedroomsInput.value = '0';
    beds = 1;
    if (bedsInput) bedsInput.value = '1';
    bathrooms = 1;
    if (bathroomsInput) bathroomsInput.value = '1';
    guests = 0;
    if (guestsInput) guestsInput.value = '0';
    welcomerService = '';
    if (welcomerSelect) welcomerSelect.value = '';
    selectedExtras = {};
    renderSupplements();
    renderCalendar();
    updateBookingBar();
  } catch (err) {
    setAppStatus(`Impossible d’enregistrer la réservation : ${authErrorMessage(err)}`, 'error');
  }
});

populateZones();
updateBookingBar();
