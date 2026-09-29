// Zebramoon, parcours de réservation guidé : une question à la fois, pas de
// rechargement de page. Utilisé à deux endroits : la page d'accueil (visiteur
// pas encore connecté, cf. index.html) et l'espace client (« réserver un
// autre ménage », cf. app/index.html). Même module, même logique, mêmes
// fonctions de tarification que le reste du site (assets/js/shared.js) : ce
// fichier ne recalcule rien, il compose l'écran autour de computeBookingPrice.
//
// L'inscription/connexion n'intervient qu'au moment de réserver, pas avant.
// Tant que la personne n'est pas connectée, ses réponses vivent dans un
// brouillon en sessionStorage (aucune écriture Firestore) ; la réservation et,
// si besoin, le logement ne sont créés qu'une fois l'authentification faite,
// avec un prix recalculé à cet instant (jamais celui affiché pendant la
// saisie, qui peut dater de plusieurs minutes).
import {
  auth,
  db,
  computeBookingPrice,
  setPricing,
  zoneFromPostalCode,
  zoneLabel,
  WELCOMER_TIERS,
  welcomerTier,
  formatShortDate,
  registerClient,
  loadUserDoc,
  authErrorMessage,
  withTimeout,
  queueEmail,
  TEAM_EMAIL,
} from './shared.js';
import {
  collection,
  query,
  where,
  onSnapshot,
  getDoc,
  getDocs,
  addDoc,
  doc,
  runTransaction,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const DRAFT_KEY = 'zm_booking_draft';
const CATALOG_LABELS = { service: 'Prestations', kit: "Kits d'accueil", consumable: 'Consommables', linen: 'Location de linge' };
const PROPERTY_TYPES = [
  { value: 'studio', label: 'Studio' },
  { value: 'appartement', label: 'Appartement' },
  { value: 'maison', label: 'Maison' },
];
const NEW_PROPERTY_STEPS = ['address', 'type', 'surface', 'bedrooms', 'bathrooms', 'beds'];

let root = null;
let onComplete = null;
let currentUser = null;
let userProperties = [];
let catalog = [];
let calendarMonth = startOfMonth(new Date());
let bookedDatesForSelection = [];
let submitting = false;
let authMode = 'signin';
let authError = '';

let draft = loadDraft() || freshDraft();
let step = draft.propertyId || draft.newProperty ? (draft.selectedDate ? 'extras' : 'date') : 'service';
let lastBookingSummary = null;

function freshDraft() {
  return {
    serviceType: 'normal',
    propertyId: null,
    propertyLabel: '',
    newProperty: null, // { street, city, postalCode, zone, propertyType, surface, bedrooms, bathrooms, beds }
    bedrooms: null, bathrooms: null, beds: null, // valeurs effectives pour un bien existant sans ces champs
    guests: 0,
    selectedDate: null,
    extras: {}, // { itemId: quantité }
    welcomerService: '',
    readyToSubmit: false,
  };
}

function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }

function loadDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveDraft() {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* stockage indisponible, tant pis */ }
}
function clearDraft() {
  draft = freshDraft();
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* rien à faire */ }
}

// Point d'entrée : mount(élément, { onComplete(bookingId) }).
export function mount(container, options = {}) {
  root = container;
  onComplete = options.onComplete || (() => {});

  subscribePricing(); // tant que l'état de connexion n'est pas connu : doc public

  onSnapshot(collection(db, 'catalog'), snap => {
    catalog = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(i => i.active !== false);
    render();
  }, () => { /* pas de suppléments affichés si le catalogue est indisponible */ });

  onAuthStateChanged(auth, user => {
    const wasSignedIn = !!currentUser;
    const justSignedIn = !wasSignedIn && user;
    currentUser = user;
    if (!!user !== wasSignedIn) subscribePricing();
    if (user) {
      subscribeProperties(user.uid);
      if (justSignedIn && draft.readyToSubmit) { finalizeBooking(); return; }
    } else {
      userProperties = [];
    }
    render();
  });

  render();
}

let pricingUnsub = null;
// Un visiteur non connecté (y compris un brouillon repris avant connexion) ne
// lit jamais que le sous-ensemble public de la tarification (sans commission
// ni abonnement, voir shared.js/PUBLIC_PRICING_FIELDS). Une fois connecté, le
// document complet est relu pour que le recalcul final (finalizeBooking) se
// fasse sur les tarifs réels, pas sur les valeurs par défaut.
function subscribePricing() {
  if (pricingUnsub) pricingUnsub();
  const ref = currentUser ? doc(db, 'settings', 'pricing') : doc(db, 'settings', 'publicPricing');
  pricingUnsub = onSnapshot(ref, snap => {
    if (snap.exists()) setPricing(snap.data());
    render();
  }, () => { /* valeurs par défaut déjà en place côté shared.js */ });
}

let propertiesUnsub = null;
function subscribeProperties(uid) {
  if (propertiesUnsub) propertiesUnsub();
  propertiesUnsub = onSnapshot(query(collection(db, 'properties'), where('ownerId', '==', uid)), snap => {
    userProperties = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, () => { userProperties = []; render(); });
}

// ---------------------------------------------------------------- rendu ----

function render() {
  if (!root) return;
  root.innerHTML = '';
  const shell = el('div', 'bk-shell');
  if (step !== 'service' && step !== 'confirm') {
    shell.appendChild(renderTopBar());
  }
  shell.appendChild(renderStep());
  root.appendChild(shell);
}

function renderTopBar() {
  const bar = el('div', 'bk-topbar');
  const back = el('button', 'bk-back');
  back.type = 'button';
  back.setAttribute('aria-label', 'Retour');
  back.innerHTML = '← Retour';
  back.addEventListener('click', goBack);
  bar.appendChild(back);
  const track = el('div', 'bk-progress');
  const fill = el('div', 'bk-progress-fill');
  fill.style.width = `${progressPercent()}%`;
  track.appendChild(fill);
  bar.appendChild(track);
  return bar;
}

const STEP_ORDER = ['service', 'property', 'date', 'extras', 'welcomer', 'review', 'auth'];
function progressPercent() {
  const base = step.startsWith('property') ? 'property' : step;
  const i = STEP_ORDER.indexOf(base);
  return i < 0 ? 10 : Math.round(((i + 1) / STEP_ORDER.length) * 100);
}

function goBack() {
  const order = ['service', 'property', 'date', 'extras', 'welcomer', 'review'];
  if (step === 'auth') { step = 'review'; render(); return; }
  if (NEW_PROPERTY_STEPS.includes(step)) {
    const i = NEW_PROPERTY_STEPS.indexOf(step);
    step = i > 0 ? NEW_PROPERTY_STEPS[i - 1] : 'property';
    render();
    return;
  }
  const i = order.indexOf(step);
  step = i > 0 ? order[i - 1] : order[0];
  render();
}

function renderStep() {
  if (NEW_PROPERTY_STEPS.includes(step)) return renderNewPropertyStep();
  switch (step) {
    case 'service': return renderServiceStep();
    case 'property': return renderPropertyStep();
    case 'date': return renderDateStep();
    case 'extras': return renderExtrasStep();
    case 'welcomer': return renderWelcomerStep();
    case 'review': return renderReviewStep();
    case 'auth': return renderAuthStep();
    case 'confirm': return renderConfirmStep();
    default: return renderServiceStep();
  }
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function question(title, subtitle) {
  const wrap = el('div', 'bk-question');
  wrap.appendChild(el('h2', null, title));
  if (subtitle) wrap.appendChild(el('p', 'bk-sub', subtitle));
  return wrap;
}

function optionCard({ title, meta, selected, onClick }) {
  const card = el('button', 'bk-option' + (selected ? ' selected' : ''));
  card.type = 'button';
  card.setAttribute('role', 'radio');
  card.setAttribute('aria-checked', selected ? 'true' : 'false');
  card.appendChild(el('div', 'bk-option-title', title));
  if (meta) card.appendChild(el('div', 'bk-option-meta', meta));
  card.addEventListener('click', onClick);
  return card;
}

function primaryButton(label, onClick, disabled) {
  const btn = el('button', 'bk-next', label);
  btn.type = 'button';
  btn.disabled = !!disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

// ------------------------------------------------------- étape : service ----

function renderServiceStep() {
  const panel = el('div', 'bk-panel bk-panel-intro');
  panel.appendChild(question('De quoi votre logement a-t-il besoin ?'));
  const group = el('div', 'bk-options');
  group.setAttribute('role', 'radiogroup');
  group.appendChild(optionCard({
    title: 'Ménage standard',
    meta: 'Remise en état complète entre deux séjours',
    selected: draft.serviceType === 'normal',
    onClick: () => { draft.serviceType = 'normal'; saveDraft(); step = 'property'; render(); },
  }));
  group.appendChild(optionCard({
    title: 'Ménage en profondeur',
    meta: 'Nettoyage approfondi, recommandé périodiquement',
    selected: draft.serviceType === 'deep',
    onClick: () => { draft.serviceType = 'deep'; saveDraft(); step = 'property'; render(); },
  }));
  panel.appendChild(group);
  return panel;
}

// ------------------------------------------------------ étape : logement ----

function renderPropertyStep() {
  const panel = el('div', 'bk-panel');
  panel.appendChild(question('Où faut-il intervenir ?'));
  if (currentUser && userProperties.length) {
    const list = el('div', 'bk-options');
    list.setAttribute('role', 'radiogroup');
    userProperties.forEach(p => {
      const meta = [p.postalCode, p.surface ? `${p.surface} m²` : null, p.bedrooms != null ? `${p.bedrooms} chambre${p.bedrooms > 1 ? 's' : ''}` : null, zoneLabel(p.zone)].filter(Boolean).join(' · ');
      list.appendChild(optionCard({
        title: `${p.street}, ${p.city}`,
        meta,
        selected: draft.propertyId === p.id,
        onClick: () => selectExistingProperty(p),
      }));
    });
    panel.appendChild(list);
    const addBtn = el('button', 'bk-link', 'Ajouter un autre logement');
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => { draft.propertyId = null; draft.newProperty = draft.newProperty || {}; step = 'address'; saveDraft(); render(); });
    panel.appendChild(addBtn);
  } else {
    // Personne pas connectée, ou aucun logement enregistré : on démarre
    // directement la saisie progressive d'un nouveau logement.
    draft.newProperty = draft.newProperty || {};
    step = 'address';
    return renderStep();
  }
  return panel;
}

function selectExistingProperty(p) {
  draft.propertyId = p.id;
  draft.propertyLabel = `${p.street}, ${p.city}`;
  draft.newProperty = null;
  draft.bedrooms = p.bedrooms != null ? p.bedrooms : null;
  draft.bathrooms = p.bathrooms != null ? p.bathrooms : null;
  draft.beds = p.beds != null ? p.beds : null;
  saveDraft();
  if (draft.bedrooms == null || draft.bathrooms == null || draft.beds == null) {
    step = 'bedrooms';
  } else {
    step = 'date';
  }
  render();
}

function renderNewPropertyStep() {
  const np = draft.newProperty || (draft.newProperty = {});
  switch (step) {
    case 'address': return renderAddressStep(np);
    case 'type': return renderPropertyTypeStep(np);
    case 'surface': return renderSurfaceStep(np);
    case 'bedrooms': return renderCountStep({
      title: 'Combien de chambres ?', field: 'bedrooms', min: 0, next: 'bathrooms',
      onSet: v => { if (draft.propertyId) draft.bedrooms = v; else np.bedrooms = v; },
      current: () => draft.propertyId ? draft.bedrooms : np.bedrooms,
    });
    case 'bathrooms': return renderCountStep({
      title: 'Combien de salles de bain ?', field: 'bathrooms', min: 1, next: 'beds',
      onSet: v => { if (draft.propertyId) draft.bathrooms = v; else np.bathrooms = v; },
      current: () => draft.propertyId ? draft.bathrooms : np.bathrooms,
    });
    case 'beds': return renderCountStep({
      title: 'Combien de lits ?', field: 'beds', min: 1, next: 'date',
      onSet: v => { if (draft.propertyId) draft.beds = v; else np.beds = v; },
      current: () => draft.propertyId ? draft.beds : np.beds,
    });
    default: return renderPropertyStep();
  }
}

function renderAddressStep(np) {
  const panel = el('div', 'bk-panel');
  panel.appendChild(question('Où devons-nous venir ?'));
  const form = el('div', 'bk-form');
  const street = labeledInput('Adresse', np.street || '', 'text');
  const city = labeledInput('Ville', np.city || '', 'text');
  const postal = labeledInput('Code postal', np.postalCode || '', 'text');
  form.append(street.wrap, city.wrap, postal.wrap);
  panel.appendChild(form);
  const errorBox = el('div', 'bk-error hidden');
  panel.appendChild(errorBox);
  panel.appendChild(primaryButton('Continuer', () => {
    const streetV = street.input.value.trim();
    const cityV = city.input.value.trim();
    const postalV = postal.input.value.trim();
    if (!streetV || !cityV || !postalV) {
      errorBox.textContent = 'Merci de renseigner l’adresse complète.';
      errorBox.classList.remove('hidden');
      return;
    }
    // La zone tarifaire se déduit du code postal : jamais demandée au client.
    np.street = streetV; np.city = cityV; np.postalCode = postalV; np.zone = zoneFromPostalCode(postalV);
    saveDraft();
    step = 'type';
    render();
  }));
  return panel;
}

function renderPropertyTypeStep(np) {
  const panel = el('div', 'bk-panel');
  panel.appendChild(question('Quel type de logement ?'));
  const group = el('div', 'bk-options');
  group.setAttribute('role', 'radiogroup');
  PROPERTY_TYPES.forEach(t => {
    group.appendChild(optionCard({
      title: t.label,
      selected: (np.propertyType || 'appartement') === t.value,
      onClick: () => { np.propertyType = t.value; saveDraft(); step = 'surface'; render(); },
    }));
  });
  panel.appendChild(group);
  return panel;
}

function renderSurfaceStep(np) {
  const panel = el('div', 'bk-panel');
  panel.appendChild(question('Quelle surface, en m² ?'));
  const form = el('div', 'bk-form');
  const surface = labeledInput('Surface (m²)', np.surface || '', 'number');
  form.appendChild(surface.wrap);
  panel.appendChild(form);
  const errorBox = el('div', 'bk-error hidden');
  panel.appendChild(errorBox);
  panel.appendChild(primaryButton('Continuer', () => {
    const v = Math.floor(Number(surface.input.value) || 0);
    if (!v || v <= 0) {
      errorBox.textContent = 'Indiquez la surface du logement.';
      errorBox.classList.remove('hidden');
      return;
    }
    np.surface = v;
    saveDraft();
    step = 'bedrooms';
    render();
  }));
  return panel;
}

function renderCountStep({ title, min, next, onSet, current }) {
  const panel = el('div', 'bk-panel');
  panel.appendChild(question(title));
  let value = Math.max(min, Number(current()) || min || 1);
  const stepper = el('div', 'bk-stepper');
  const minus = el('button', 'bk-stepper-btn', '−');
  minus.type = 'button';
  const count = el('div', 'bk-stepper-count', String(value));
  const plus = el('button', 'bk-stepper-btn', '+');
  plus.type = 'button';
  minus.addEventListener('click', () => { value = Math.max(min, value - 1); count.textContent = String(value); });
  plus.addEventListener('click', () => { value = value + 1; count.textContent = String(value); });
  stepper.append(minus, count, plus);
  panel.appendChild(stepper);
  panel.appendChild(primaryButton('Continuer', () => {
    onSet(value);
    saveDraft();
    step = next;
    render();
  }));
  return panel;
}

function labeledInput(labelText, value, type) {
  const wrap = el('div', 'bk-field');
  wrap.appendChild(el('label', null, labelText));
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  wrap.appendChild(input);
  return { wrap, input };
}

// ---------------------------------------------------------- étape : date ----

function renderDateStep() {
  const panel = el('div', 'bk-panel');
  panel.appendChild(question('Quand souhaitez-vous notre passage ?'));
  if (authError) {
    panel.appendChild(el('div', 'bk-error', authError));
  }
  const cal = el('div', 'bk-calendar');
  const head = el('div', 'bk-cal-head');
  const prev = el('button', 'bk-cal-nav', '‹');
  prev.type = 'button';
  const label = el('div', 'bk-cal-month');
  const next = el('button', 'bk-cal-nav', '›');
  next.type = 'button';
  head.append(prev, label, next);
  cal.appendChild(head);
  const grid = el('div', 'bk-cal-grid');
  cal.appendChild(grid);
  panel.appendChild(cal);

  loadTakenDates().then(() => paintCalendar(grid, label, prev, next));
  paintCalendar(grid, label, prev, next);

  prev.addEventListener('click', () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1); paintCalendar(grid, label, prev, next); });
  next.addEventListener('click', () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1); paintCalendar(grid, label, prev, next); });

  if (draft.selectedDate) {
    const chosen = el('div', 'bk-chosen-date', `Le ${formatShortDate(draft.selectedDate)}`);
    panel.appendChild(chosen);
    panel.appendChild(primaryButton('Continuer', () => { step = 'extras'; render(); }));
  }
  return panel;
}

async function loadTakenDates() {
  bookedDatesForSelection = [];
  if (!currentUser || !draft.propertyId) return;
  try {
    const snap = await getDocs(query(collection(db, 'bookings'), where('clientId', '==', currentUser.uid), where('propertyId', '==', draft.propertyId)));
    bookedDatesForSelection = snap.docs.map(d => d.data()).filter(b => !['rejected', 'cancelled'].includes(b.status)).map(b => b.scheduledDate);
  } catch { bookedDatesForSelection = []; }
}

function paintCalendar(grid, label, prev) {
  grid.innerHTML = '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const currentMonth = startOfMonth(today);
  if (calendarMonth < currentMonth) calendarMonth = currentMonth;
  const monthLabel = calendarMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  label.textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
  prev.disabled = calendarMonth.getTime() === currentMonth.getTime();

  ['L', 'M', 'M', 'J', 'V', 'S', 'D'].forEach(d => grid.appendChild(el('div', 'bk-cal-daylabel', d)));

  const mondayOffset = (calendarMonth.getDay() + 6) % 7;
  for (let i = 0; i < mondayOffset; i += 1) grid.appendChild(el('div', 'bk-cal-day empty'));

  const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum += 1) {
    const day = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), dayNum);
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const isPast = day < today;
    const isBooked = bookedDatesForSelection.includes(iso);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bk-cal-day' + (isPast ? ' past' : '') + (isBooked ? ' booked' : '') + (draft.selectedDate === iso ? ' selected' : '') + (day.getTime() === today.getTime() ? ' today' : '');
    btn.textContent = String(dayNum);
    btn.disabled = isPast || isBooked;
    btn.setAttribute('aria-label', formatShortDate(iso) + (isBooked ? ', déjà réservé' : ''));
    if (!btn.disabled) {
      btn.addEventListener('click', () => { draft.selectedDate = iso; authError = ''; saveDraft(); render(); });
    }
    grid.appendChild(btn);
  }
}

// -------------------------------------------------------- étape : extras ----

function renderExtrasStep() {
  const panel = el('div', 'bk-panel');
  panel.appendChild(question('Autre chose ?', 'Linge, kit de bienvenue, consommables.'));
  if (!catalog.length) {
    step = 'welcomer';
    return renderStep();
  }
  const list = el('div', 'bk-extras');
  const beds = effectiveBeds();
  const guests = draft.guests || 0;
  ['service', 'kit', 'consumable', 'linen'].forEach(type => {
    const items = catalog.filter(i => i.type === type).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!items.length) return;
    list.appendChild(el('div', 'bk-extras-head', CATALOG_LABELS[type] || type));
    items.forEach(item => list.appendChild(renderExtraRow(item, beds, guests)));
  });
  panel.appendChild(list);
  const row = el('div', 'bk-step-actions');
  const skip = el('button', 'bk-link', 'Passer');
  skip.type = 'button';
  skip.addEventListener('click', () => { step = 'welcomer'; render(); });
  row.appendChild(skip);
  row.appendChild(primaryButton('Continuer', () => { step = 'welcomer'; render(); }));
  panel.appendChild(row);
  return panel;
}

function effectiveBeds() { return draft.propertyId ? (draft.beds || 1) : ((draft.newProperty || {}).beds || 1); }

function renderExtraRow(item, beds, guests) {
  const row = el('div', 'bk-extra-row');
  const info = el('div', null);
  info.appendChild(el('div', 'bk-extra-name', item.name || '(sans nom)'));
  const auto = item.unit === 'bed' || item.unit === 'guest';
  const basis = item.unit === 'bed' ? beds : guests;
  info.appendChild(el('div', 'bk-extra-meta', `${Number(item.priceTTC) || 0}€ TTC / ${item.unit === 'bed' ? 'lit' : item.unit === 'guest' ? 'voyageur' : 'unité'}`));
  row.appendChild(info);
  if (auto) {
    const wrap = el('label', 'bk-extra-check');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = (draft.extras[item.id] || 0) > 0;
    wrap.appendChild(cb);
    if (item.unit === 'guest' && !guests) {
      const guestInput = document.createElement('input');
      guestInput.type = 'number';
      guestInput.min = '1';
      guestInput.className = 'bk-inline-number hidden';
      guestInput.placeholder = 'Voyageurs';
      wrap.appendChild(guestInput);
      cb.addEventListener('change', () => {
        if (cb.checked) { guestInput.classList.remove('hidden'); }
        else { guestInput.classList.add('hidden'); delete draft.extras[item.id]; saveDraft(); render(); }
      });
      guestInput.addEventListener('input', () => {
        const n = Math.max(0, Math.floor(Number(guestInput.value) || 0));
        draft.guests = n;
        if (n > 0) draft.extras[item.id] = n; else delete draft.extras[item.id];
        saveDraft();
      });
    } else {
      wrap.appendChild(el('span', null, `× ${basis} ${item.unit === 'bed' ? 'lit' : 'voyageur'}${basis > 1 ? 's' : ''}`));
      cb.addEventListener('change', () => {
        if (cb.checked && basis > 0) draft.extras[item.id] = basis; else delete draft.extras[item.id];
        saveDraft();
      });
    }
    row.appendChild(wrap);
  } else {
    const qty = document.createElement('input');
    qty.type = 'number';
    qty.min = '0';
    qty.className = 'bk-inline-number';
    qty.value = draft.extras[item.id] || 0;
    qty.setAttribute('aria-label', `Quantité, ${item.name || ''}`);
    qty.addEventListener('input', () => {
      const n = Math.max(0, Math.floor(Number(qty.value) || 0));
      if (n > 0) draft.extras[item.id] = n; else delete draft.extras[item.id];
      saveDraft();
    });
    row.appendChild(qty);
  }
  return row;
}

// ------------------------------------------------------ étape : welcomer ----

function renderWelcomerStep() {
  const panel = el('div', 'bk-panel');
  panel.appendChild(question('Un contrôle qualité en plus ?', 'Un membre de notre équipe vérifie le logement après le ménage, avec photos et checklist.'));
  const group = el('div', 'bk-options');
  group.setAttribute('role', 'radiogroup');
  group.appendChild(optionCard({
    title: 'Non merci',
    selected: !draft.welcomerService,
    onClick: () => { draft.welcomerService = ''; saveDraft(); step = 'review'; render(); },
  }));
  WELCOMER_TIERS.forEach(t => {
    group.appendChild(optionCard({
      title: t.label,
      meta: `${t.fee}€ HT`,
      selected: draft.welcomerService === t.key,
      onClick: () => { draft.welcomerService = t.key; saveDraft(); step = 'review'; render(); },
    }));
  });
  panel.appendChild(group);
  return panel;
}

// --------------------------------------------------------- étape : bilan ----

function currentQuote() {
  const np = draft.newProperty;
  const surface = draft.propertyId
    ? (userProperties.find(p => p.id === draft.propertyId) || {}).surface
    : (np || {}).surface;
  const zone = draft.propertyId
    ? (userProperties.find(p => p.id === draft.propertyId) || {}).zone
    : (np || {}).zone;
  const bedrooms = draft.propertyId ? draft.bedrooms : (np || {}).bedrooms;
  const bathrooms = draft.propertyId ? draft.bathrooms : (np || {}).bathrooms;
  const beds = draft.propertyId ? draft.beds : (np || {}).beds;
  if (!surface) return null;
  return computeBookingPrice({ surface, serviceType: draft.serviceType, beds, bathrooms, bedrooms, zone });
}

function extrasList() {
  return catalog
    .filter(i => (draft.extras[i.id] || 0) > 0)
    .map(i => {
      const qty = draft.extras[i.id];
      const priceHT = Number(i.priceHT) || 0;
      return { id: i.id, name: i.name || '', type: i.type || '', priceHT, priceTTC: Number(i.priceTTC) || 0, qty, lineHT: priceHT * qty };
    });
}

function renderReviewStep() {
  const panel = el('div', 'bk-panel');
  panel.appendChild(question('Votre ménage'));
  const quote = currentQuote();
  const extras = quote ? extrasList() : [];
  const summary = el('div', 'bk-summary');

  summary.appendChild(summaryRow('Logement', propertyLabelForReview(), () => { step = draft.propertyId ? 'property' : 'address'; render(); }));
  summary.appendChild(summaryRow('Prestation', draft.serviceType === 'deep' ? 'Ménage en profondeur' : 'Ménage standard', () => { step = 'service'; render(); }));
  summary.appendChild(summaryRow('Date', draft.selectedDate ? formatShortDate(draft.selectedDate) : ',', () => { step = 'date'; render(); }));
  summary.appendChild(summaryRow('Suppléments', extras.length ? extras.map(e => `${e.name}${e.qty > 1 ? ` ×${e.qty}` : ''}`).join(', ') : 'Aucun', () => { step = 'extras'; render(); }));
  summary.appendChild(summaryRow('Contrôle qualité', draft.welcomerService ? (welcomerTier(draft.welcomerService) || {}).label : 'Non', () => { step = 'welcomer'; render(); }));
  panel.appendChild(summary);

  const priceBox = el('div', 'bk-price-box');
  if (!quote) {
    priceBox.appendChild(el('div', 'bk-error', 'Il manque la surface du logement pour calculer le prix.'));
  } else if (quote.custom) {
    priceBox.appendChild(el('div', 'bk-note', 'Logement de plus de 250 m² : tarif sur mesure, nous vous recontactons avec un prix.'));
  } else {
    const welcomerFee = draft.welcomerService ? (welcomerTier(draft.welcomerService) || {}).fee || 0 : 0;
    const extrasHT = extras.reduce((s, e) => s + e.lineHT, 0);
    const finalHT = quote.total + extrasHT + welcomerFee;
    const vat = Math.round(finalHT * quote.vatRate);
    const ttc = finalHT + vat;
    priceBox.appendChild(el('div', 'bk-price-total', `${ttc}€`));
    priceBox.appendChild(el('div', 'bk-price-sub', 'TTC, toutes options incluses'));
  }
  panel.appendChild(priceBox);

  const errorBox = el('div', 'bk-error hidden');
  if (authError) { errorBox.textContent = authError; errorBox.classList.remove('hidden'); }
  panel.appendChild(errorBox);

  const canSubmit = !!quote && !!draft.selectedDate;
  const label = quote && quote.custom ? 'Demander un devis' : 'Réserver ce ménage';
  panel.appendChild(primaryButton(label, () => {
    draft.readyToSubmit = true;
    saveDraft();
    if (!currentUser) { step = 'auth'; render(); return; }
    finalizeBooking();
  }, submitting || !canSubmit));

  return panel;
}

function propertyLabelForReview() {
  if (draft.propertyId) {
    const p = userProperties.find(pp => pp.id === draft.propertyId);
    return p ? `${p.street}, ${p.city}` : draft.propertyLabel;
  }
  const np = draft.newProperty || {};
  return np.street ? `${np.street}, ${np.city}` : 'Logement à préciser';
}

function summaryRow(label, value, onChange) {
  const row = el('div', 'bk-summary-row');
  row.appendChild(el('div', 'bk-summary-label', label));
  row.appendChild(el('div', 'bk-summary-value', value));
  const change = el('button', 'bk-link', 'Modifier');
  change.type = 'button';
  change.addEventListener('click', onChange);
  row.appendChild(change);
  return row;
}

// ---------------------------------------------------- étape : connexion ----

function renderAuthStep() {
  const panel = el('div', 'bk-panel');
  panel.appendChild(question(
    authMode === 'signin' ? 'Connectez-vous pour finaliser' : 'Créez votre compte pour finaliser',
    'Votre réservation et le prix affiché sont conservés.',
  ));
  const form = el('div', 'bk-form');
  if (authMode === 'register') {
    const name = labeledInput('Nom', '', 'text');
    const phone = labeledInput('Téléphone', '', 'tel');
    form.append(name.wrap, phone.wrap);
    form.dataset.hasNamePhone = '1';
  }
  const email = labeledInput('Email', '', 'email');
  const password = labeledInput('Mot de passe', '', 'password');
  form.append(email.wrap, password.wrap);
  panel.appendChild(form);

  const errorBox = el('div', 'bk-error hidden');
  if (authError) { errorBox.textContent = authError; errorBox.classList.remove('hidden'); }
  panel.appendChild(errorBox);

  panel.appendChild(primaryButton(authMode === 'signin' ? 'Se connecter et réserver' : 'Créer mon compte et réserver', async () => {
    authError = '';
    const emailV = email.input.value.trim();
    const passwordV = password.input.value;
    if (!emailV || !passwordV) { authError = 'Renseignez votre email et votre mot de passe.'; render(); return; }
    submitting = true; render();
    try {
      if (authMode === 'signin') {
        await signInWithEmailAndPassword(auth, emailV, passwordV);
      } else {
        const nameInput = form.querySelector('input[type="text"]');
        const phoneInput = form.querySelector('input[type="tel"]');
        await registerClient({ name: nameInput ? nameInput.value.trim() : '', email: emailV, password: passwordV, phone: phoneInput ? phoneInput.value.trim() : '' });
      }
      // La suite (création du logement/réservation) se déclenche depuis
      // onAuthStateChanged, une fois currentUser mis à jour.
    } catch (err) {
      authError = authErrorMessage(err);
      submitting = false;
      render();
    }
  }, submitting));

  const toggle = el('button', 'bk-link', authMode === 'signin' ? 'Pas encore de compte ? Créez-le' : 'Déjà un compte ? Connectez-vous');
  toggle.type = 'button';
  toggle.addEventListener('click', () => { authMode = authMode === 'signin' ? 'register' : 'signin'; authError = ''; render(); });
  panel.appendChild(toggle);

  return panel;
}

// ------------------------------------------------- finalisation + envoi ----

// registerClient() attend déjà l'écriture de /users/{uid} avant de rendre la
// main, mais onAuthStateChanged (qui déclenche finalizeBooking juste après
// l'inscription) est un écouteur indépendant : rien ne garantit qu'il ne se
// déclenche pas avant que ce document soit lisible. Sans lui, isClient() côté
// règles Firestore échoue et la création du logement/réservation est refusée
// juste après une inscription pourtant réussie. On attend ici, brièvement,
// que le document existe et soit approuvé avant d'écrire quoi que ce soit.
async function waitForUserDoc(uid, attempts = 6, delayMs = 350) {
  for (let i = 0; i < attempts; i += 1) {
    const docData = await loadUserDoc(uid).catch(() => null);
    if (docData && docData.accountStatus === 'approved') return docData;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return null;
}

async function finalizeBooking() {
  if (!currentUser) return;
  submitting = true; render();
  try {
    const userReady = await waitForUserDoc(currentUser.uid);
    if (!userReady) {
      const err = new Error('Votre compte vient d’être créé, sa mise en place prend encore quelques secondes. Réessayez dans un instant.');
      err.code = 'app/user-not-ready';
      throw err;
    }

    // Relit la tarification COMPLÈTE juste avant de calculer le prix final :
    // la souscription au document complet (déclenchée par la connexion qui
    // vient de se produire) n'a pas forcément encore livré son premier
    // instantané. Une lecture directe évite de calculer sur les valeurs par
    // défaut restées en mémoire depuis la tarification publique pré-connexion.
    try {
      const pricingSnap = await getDoc(doc(db, 'settings', 'pricing'));
      if (pricingSnap.exists()) setPricing(pricingSnap.data());
    } catch { /* on garde la config actuellement en mémoire */ }

    let propertyId = draft.propertyId;
    let property;
    if (!propertyId) {
      const np = draft.newProperty || {};
      const created = await withTimeout(addDoc(collection(db, 'properties'), {
        ownerId: currentUser.uid,
        street: np.street || '',
        city: np.city || '',
        postalCode: np.postalCode || '',
        surface: Number(np.surface) || 0,
        zone: np.zone || '',
        propertyType: np.propertyType || 'appartement',
        bedrooms: Number(np.bedrooms) || 0,
        bathrooms: Number(np.bathrooms) || 1,
        beds: Number(np.beds) || 1,
        notes: '',
        keyAccess: '',
        createdAt: serverTimestamp(),
      }), 15000);
      propertyId = created.id;
      property = { id: propertyId, street: np.street, city: np.city, surface: np.surface, zone: np.zone };
    } else {
      property = userProperties.find(p => p.id === propertyId);
      if (!property) throw new Error('Logement introuvable.');
    }

    const bedrooms = draft.propertyId ? draft.bedrooms : (draft.newProperty || {}).bedrooms;
    const bathrooms = draft.propertyId ? draft.bathrooms : (draft.newProperty || {}).bathrooms;
    const beds = draft.propertyId ? draft.beds : (draft.newProperty || {}).beds;
    // Prix recalculé maintenant, jamais celui affiché pendant la saisie.
    const quote = computeBookingPrice({ surface: property.surface, serviceType: draft.serviceType, beds, bathrooms, bedrooms, zone: property.zone });
    if (!quote) throw new Error('Surface du logement manquante.');

    if (quote.custom) {
      const address = `${property.street}, ${property.city}`;
      const text = `Demande de devis (sur-mesure, > 250 m²), ${address} · ${property.surface} m² · ${draft.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'} · date souhaitée : ${formatShortDate(draft.selectedDate)}.`;
      await withTimeout(addDoc(collection(db, 'messages'), {
        bookingId: '', clientId: currentUser.uid, clientEmail: currentUser.email, clientName: currentUser.displayName || '',
        propertyAddress: address, text, status: 'open', createdAt: serverTimestamp(),
      }), 15000);
      queueEmail({ to: TEAM_EMAIL, subject: `Zebramoon, demande de devis · ${address}`, text: `${text} Client : ${currentUser.email}.` });
      clearDraft();
      step = 'confirm';
      submitting = false;
      render();
      return;
    }

    const extras = extrasList().map(e => ({ id: e.id, name: e.name, type: e.type, priceHT: e.priceHT, priceTTC: e.priceTTC, qty: e.qty }));
    const extrasHT = extras.reduce((s, e) => s + e.priceHT * e.qty, 0);
    const welcomerFee = draft.welcomerService ? (welcomerTier(draft.welcomerService) || {}).fee || 0 : 0;
    const finalHT = quote.total + extrasHT + welcomerFee;
    const vat = Math.round(finalHT * quote.vatRate);
    const finalTTC = finalHT + vat;

    // Le créneau (logement + date) et la réservation sont écrits dans la même
    // transaction : si un autre onglet/appareil a réservé la même date entre
    // temps (brouillon resté ouvert, double clic, session reprise), Firestore
    // refuse la seconde écriture du verrou et la transaction échoue proprement
    // plutôt que de créer une réservation en doublon (voir firestore.rules,
    // collection bookingSlots).
    const slotRef = doc(db, 'bookingSlots', `${propertyId}_${draft.selectedDate}`);
    const bookingRef = doc(collection(db, 'bookings'));
    await withTimeout(runTransaction(db, async tx => {
      const slotSnap = await tx.get(slotRef);
      if (slotSnap.exists()) {
        const err = new Error('SLOT_TAKEN');
        err.code = 'app/slot-taken';
        throw err;
      }
      tx.set(bookingRef, {
        clientId: currentUser.uid,
        propertyId,
        propertyAddress: `${property.street}, ${property.city}`,
        keyAccess: property.keyAccess || '',
        prestataireId: null,
        livreurId: null,
        welcomerId: null,
        serviceType: quote.serviceType,
        surface: Number(property.surface),
        zone: property.zone || '',
        propertyType: draft.propertyId ? (property.propertyType || 'appartement') : ((draft.newProperty || {}).propertyType || 'appartement'),
        beds: quote.beds,
        bathrooms: quote.bathrooms,
        guests: Number(draft.guests) || 0,
        hours: quote.hours,
        bedrooms: quote.bedrooms,
        kitCount: quote.kitCount,
        linenRequested: quote.kitCount > 0,
        prestationPrice: quote.prestation,
        amenitiesPrice: quote.amenitiesTotal,
        travelFee: quote.travel,
        commission: quote.commission,
        extras,
        extrasHT,
        welcomerService: draft.welcomerService || '',
        welcomerFee,
        price: finalHT,
        scheduledDate: draft.selectedDate,
        status: 'pending',
        createdAt: serverTimestamp(),
      });
      tx.set(slotRef, {
        propertyId,
        scheduledDate: draft.selectedDate,
        bookingId: bookingRef.id,
        clientId: currentUser.uid,
        createdAt: serverTimestamp(),
      });
    }), 20000);

    queueEmail({
      to: TEAM_EMAIL,
      subject: `Zebramoon, nouvelle réservation · ${property.street}, ${property.city}`,
      text: `${formatShortDate(draft.selectedDate)} · ${finalHT}€ HT · client ${currentUser.email}.`,
    });

    clearDraft();
    step = 'confirm';
    lastBookingSummary = { property, date: draft.selectedDate, serviceType: quote.serviceType, priceTTC: finalTTC, welcomer: draft.welcomerService, bookingId: bookingRef.id };
    submitting = false;
    render();
    onComplete(bookingRef.id);
  } catch (err) {
    if (err && err.code === 'app/slot-taken') {
      draft.selectedDate = null;
      saveDraft();
      authError = 'Cette date vient d’être réservée pour ce logement. Merci d’en choisir une autre.';
      submitting = false;
      step = 'date';
      render();
      return;
    }
    authError = authErrorMessage(err);
    submitting = false;
    step = 'review';
    render();
  }
}

function renderConfirmStep() {
  const panel = el('div', 'bk-panel bk-confirm');
  panel.appendChild(el('div', 'bk-confirm-mark', '✓'));
  panel.appendChild(el('h2', null, 'Vous êtes réservé.'));
  if (lastBookingSummary) {
    const s = lastBookingSummary;
    panel.appendChild(el('p', 'bk-sub', `${s.property.street}, ${s.property.city} · ${formatShortDate(s.date)} · ${s.serviceType === 'deep' ? 'Ménage en profondeur' : 'Ménage standard'}`));
    panel.appendChild(el('div', 'bk-price-total', `${s.priceTTC}€`));
    panel.appendChild(el('div', 'bk-price-sub', `TTC · Référence ${s.bookingId.slice(0, 6).toUpperCase()}`));
  } else {
    panel.appendChild(el('p', 'bk-sub', 'Votre demande de devis a bien été envoyée, nous revenons vers vous rapidement.'));
  }
  const link = el('a', 'bk-next', 'Voir ma réservation');
  link.href = '/app/';
  panel.appendChild(link);
  return panel;
}

// Réinitialise le module (utile si on veut relancer un parcours propre,
// par ex. « réserver un autre ménage » depuis le tableau de bord).
export function reset() {
  clearDraft();
  step = 'service';
  authMode = 'signin';
  authError = '';
  lastBookingSummary = null;
  render();
}
