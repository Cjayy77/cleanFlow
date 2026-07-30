// CleanFlow — interface admin : file de vérification des dossiers photo.
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
  armInlineConfirm,
  withTimeout,
  resetPassword,
  requestTeamAccess,
  queueEmail,
  getPricing,
  setPricing,
  DEFAULT_PRICING,
  PRICING_SCALARS,
  openDevisDocument,
} from './shared.js';
import {
  collection,
  query,
  where,
  onSnapshot,
  updateDoc,
  setDoc,
  addDoc,
  deleteDoc,
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
const bookingCost = document.getElementById('bookingCost');
const photoGrid = document.getElementById('photoGrid');
const verifyBtn = document.getElementById('verifyBtn');
const rejectBtn = document.getElementById('rejectBtn');
const devisBtn = document.getElementById('devisBtn');
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
const adminCalendar = document.getElementById('adminCalendar');
const adminCalMonth = document.getElementById('adminCalMonth');
const adminCalPrev = document.getElementById('adminCalPrev');
const adminCalNext = document.getElementById('adminCalNext');
const roster = document.getElementById('roster');
const adminTabs = document.getElementById('adminTabs');
const badgeAssign = document.getElementById('badgeAssign');
const badgeVerify = document.getElementById('badgeVerify');
const badgeInbox = document.getElementById('badgeInbox');
const badgeTeam = document.getElementById('badgeTeam');

let currentUser = null;
let authNotice = null;
let selectedBooking = null;
let bookingQueueData = [];
let bookingQueueUnsub = null;
let statsUnsub = null;
let pricingUnsub = null;
let catalogUnsub = null;
let latestCatalog = [];
let incidentsUnsub = null;
let messagesUnsub = null;
let latestBookings = [];
let prestataires = [];
let livreurs = [];
let suspended = { prestataire: [], livreur: [] };
let membersUnsubs = [];
let openMessagesCount = 0;
let openIncidentsCount = 0;
let accessRequestCount = 0;

function activateTab(name) {
  if (!adminTabs) return;
  adminTabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.admin-section').forEach(s => s.classList.toggle('hidden', s.dataset.tab !== name));
}

function setBadge(el, count) {
  if (!el) return;
  el.textContent = count;
  el.classList.toggle('hidden', !count);
}

// Compteurs « ce qui demande une action » affichés sur les onglets.
function renderTabBadges() {
  const toAssign = latestBookings.filter(b => b.status === 'pending').length
    + latestBookings.filter(b => b.linenRequested === true && !b.livreurId && b.status !== 'cancelled').length;
  const toVerify = latestBookings.filter(b => b.status === 'submitted').length;
  const urgentCount = latestBookings.filter(bookingIsUrgent).length;
  setBadge(badgeAssign, toAssign);
  if (badgeAssign) badgeAssign.classList.toggle('urgent', urgentCount > 0);
  setBadge(badgeVerify, toVerify);
  setBadge(badgeInbox, openMessagesCount + openIncidentsCount);
  setBadge(badgeTeam, accessRequestCount);
}
let adminCalMonthDate = startOfMonth(new Date());
let selectedCalDay = null;

// Période de la compta : semaine / mois / année en cours, tout, ou plage libre.
let comptaRange = 'month';
let comptaCustom = { from: '', to: '' };
let comptaPrestataire = ''; // '' = tous les prestataires
let comptaSearch = '';      // recherche par adresse / bien

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

// Ordre d'affichage dans une journée : ce qui demande une action d'abord.
const CAL_STATUS_ORDER = { pending: 0, submitted: 1, rejected: 2, accepted: 3, verified: 4 };

// Fenêtre d'alerte : une réservation non assignée dont la date arrive dans les
// 3 jours (ou déjà passée) doit sauter aux yeux.
const URGENT_DAYS = 3;

function isoInDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Non assignée (prestataire manquant, ou livreur manquant pour les kits) et
// dont l'échéance est proche ou dépassée.
function bookingIsUrgent(booking) {
  if (!booking.scheduledDate || booking.status === 'cancelled') return false;
  if (booking.scheduledDate > isoInDays(URGENT_DAYS)) return false;
  const needsPrestataire = booking.status === 'pending';
  const needsLivreur = booking.linenRequested === true && !booking.livreurId && booking.status !== 'verified';
  return needsPrestataire || needsLivreur;
}

function prestataireName(id) {
  const member = prestataires.find(p => p.id === id);
  return member ? (member.name || member.email) : 'prestataire';
}

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

// ---- Back-office tarifs : charge, édite et enregistre la config de prix ----
function subscribePricing() {
  if (pricingUnsub) pricingUnsub();
  pricingUnsub = onSnapshot(doc(db, 'settings', 'pricing'), snap => {
    if (snap.exists()) setPricing(snap.data());
    renderPricingForm();
  }, error => setPricingStatus(`Impossible de charger les tarifs : ${authErrorMessage(error)}`, 'error'));
}

function setPricingStatus(message, type) {
  const el = document.getElementById('pricingStatus');
  if (!el) return;
  el.textContent = message;
  el.className = `status-banner ${type || ''}`.trim();
  el.classList.toggle('hidden', !message);
}

// Petit générateur de champ « label + input numérique ».
function priceField(label, value, opts) {
  opts = opts || {};
  const row = document.createElement('label');
  row.className = 'price-field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = opts.step || '1';
  if (opts.min != null) input.min = opts.min;
  input.value = value;
  input.dataset.key = opts.key || '';
  row.appendChild(span);
  row.appendChild(input);
  if (opts.suffix) { const s = document.createElement('em'); s.textContent = opts.suffix; row.appendChild(s); }
  return row;
}

function renderPricingForm() {
  const form = document.getElementById('pricingForm');
  if (!form) return;
  const P = getPricing();
  form.innerHTML = '';

  const group = (title) => {
    const g = document.createElement('div');
    g.className = 'price-group';
    const h = document.createElement('div');
    h.className = 'roster-subhead';
    h.textContent = title;
    g.appendChild(h);
    form.appendChild(g);
    return g;
  };

  // Tarifs horaires
  const g1 = group('Tarifs horaires (€ HT / h)');
  g1.appendChild(priceField('Ménage standard', P.hourlyRates.normal, { key: 'rate_normal', suffix: '€/h' }));
  g1.appendChild(priceField('Nettoyage approfondi', P.hourlyRates.deep, { key: 'rate_deep', suffix: '€/h' }));

  // Grille de durée (bandes de surface)
  const g2 = group('Durée de base par surface (colonne « 1 lit »)');
  const bandsWrap = document.createElement('div');
  bandsWrap.id = 'pricingBands';
  g2.appendChild(bandsWrap);
  P.timeGrid.forEach(b => bandsWrap.appendChild(bandRow(b.max, b.baseHours)));
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'mini-btn';
  addBtn.textContent = '+ Ajouter une tranche';
  addBtn.onclick = () => bandsWrap.appendChild(bandRow('', ''));
  g2.appendChild(addBtn);

  // Règles de durée
  const g3 = group('Règles de durée');
  g3.appendChild(priceField('Heures par lit supplémentaire', P.hoursPerExtraBed, { key: 'hoursPerExtraBed', step: '0.25', suffix: 'h' }));
  g3.appendChild(priceField('Heures par 25 m² au-delà de la grille', P.hoursPer25sqmAbove90, { key: 'hoursPer25sqmAbove90', step: '0.25', suffix: 'h' }));
  g3.appendChild(priceField('Surface max. calcul auto (au-delà : devis)', P.maxAutoSurface, { key: 'maxAutoSurface', suffix: 'm²' }));

  // Suppléments & abonnement
  const g4 = group('Suppléments, abonnement & commission');
  g4.appendChild(priceField('Kit de bienvenue (par chambre)', P.kitPrice, { key: 'kitPrice', suffix: '€' }));
  g4.appendChild(priceField('Frais de déplacement', P.travelFee, { key: 'travelFee', suffix: '€' }));
  g4.appendChild(priceField('Abonnement application', P.subscriptionMonthly, { key: 'subscriptionMonthly', suffix: '€/mois' }));
  g4.appendChild(priceField('Commission CleanFlow — min', P.commissionMin, { key: 'commissionMin', suffix: '€' }));
  g4.appendChild(priceField('Commission CleanFlow — max', P.commissionMax, { key: 'commissionMax', suffix: '€' }));
  g4.appendChild(priceField('TVA', Math.round(P.vatRate * 100), { key: 'vatPct', suffix: '%' }));

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn primary';
  save.textContent = 'Enregistrer les tarifs';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn ghost';
  reset.textContent = 'Réinitialiser (barème par défaut)';
  armInlineConfirm(reset, 'Confirmer la réinitialisation', () => savePricing(DEFAULT_PRICING));
  actions.appendChild(save);
  actions.appendChild(reset);
  form.appendChild(actions);
}

function bandRow(max, baseHours) {
  const row = document.createElement('div');
  row.className = 'band-row';
  const m = document.createElement('input');
  m.type = 'number'; m.min = '1'; m.placeholder = 'm² max'; m.value = max; m.dataset.role = 'max';
  const arrow = document.createElement('span'); arrow.textContent = '→';
  const h = document.createElement('input');
  h.type = 'number'; h.min = '0'; h.step = '0.25'; h.placeholder = 'heures'; h.value = baseHours; h.dataset.role = 'hours';
  const hLabel = document.createElement('em'); hLabel.textContent = 'h';
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'mini-btn danger'; del.textContent = '✕';
  del.onclick = () => row.remove();
  row.append(m, arrow, h, hLabel, del);
  return row;
}

// Lit le formulaire, construit une config propre et l'enregistre.
function collectPricingFromForm() {
  const form = document.getElementById('pricingForm');
  const val = (key) => {
    const el = form.querySelector(`input[data-key="${key}"]`);
    return el ? Number(el.value) : NaN;
  };
  const bands = Array.from(form.querySelectorAll('#pricingBands .band-row')).map(r => ({
    max: Number(r.querySelector('input[data-role="max"]').value),
    baseHours: Number(r.querySelector('input[data-role="hours"]').value),
  }));
  return {
    hourlyRates: { normal: val('rate_normal'), deep: val('rate_deep') },
    timeGrid: bands,
    hoursPerExtraBed: val('hoursPerExtraBed'),
    hoursPer25sqmAbove90: val('hoursPer25sqmAbove90'),
    maxAutoSurface: val('maxAutoSurface'),
    kitPrice: val('kitPrice'),
    travelFee: val('travelFee'),
    subscriptionMonthly: val('subscriptionMonthly'),
    commissionMin: val('commissionMin'),
    commissionMax: val('commissionMax'),
    vatRate: val('vatPct') / 100,
  };
}

async function savePricing(config) {
  const clean = {};
  // On enregistre une config déjà normalisée par le moteur (mêmes défauts de secours).
  const normalized = setPricing(config); // met aussi à jour l'aperçu local
  Object.assign(clean, normalized);
  try {
    await withTimeout(setDoc(doc(db, 'settings', 'pricing'), { ...clean, updatedAt: serverTimestamp() }), 15000);
    setPricingStatus('Tarifs enregistrés. Les nouvelles réservations utilisent ce barème.', 'success');
  } catch (error) {
    setPricingStatus(`Enregistrement impossible : ${authErrorMessage(error)}`, 'error');
  }
}

// ---- Back-office catalogue : kits, consommables, location de linge ----
const CATALOG_TYPES = [
  { key: 'kit', label: "Kits d'accueil", singular: 'un kit', hasStock: false, hasCategory: false },
  { key: 'consumable', label: 'Consommables', singular: 'un consommable', hasStock: true, hasCategory: true },
  { key: 'linen', label: 'Location de linge', singular: 'un article de linge', hasStock: false, hasCategory: false },
];

function subscribeCatalog() {
  if (catalogUnsub) catalogUnsub();
  catalogUnsub = onSnapshot(collection(db, 'catalog'), snap => {
    latestCatalog = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderCatalog();
  }, error => setCatalogStatus(`Impossible de charger le catalogue : ${authErrorMessage(error)}`, 'error'));
}

function setCatalogStatus(message, type) {
  const el = document.getElementById('catalogStatus');
  if (!el) return;
  el.textContent = message;
  el.className = `status-banner ${type || ''}`.trim();
  el.classList.toggle('hidden', !message);
}

function renderCatalog() {
  const root = document.getElementById('catalogRoot');
  if (!root) return;
  root.innerHTML = '';
  CATALOG_TYPES.forEach(type => {
    const group = document.createElement('div');
    group.className = 'catalog-group';
    const head = document.createElement('div');
    head.className = 'roster-subhead';
    head.textContent = type.label;
    group.appendChild(head);

    const items = latestCatalog
      .filter(i => i.type === type.key)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Aucun article pour le moment.';
      group.appendChild(empty);
    } else {
      items.forEach(item => group.appendChild(buildCatalogCard(item, type)));
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn ghost';
    addBtn.style.marginTop = '12px';
    addBtn.textContent = `+ Ajouter ${type.singular}`;
    addBtn.onclick = () => {
      if (group.querySelector('.catalog-form')) return; // un seul formulaire à la fois
      addBtn.before(catalogItemForm(type, null));
    };
    group.appendChild(addBtn);
    root.appendChild(group);
  });
}

function buildCatalogCard(item, type) {
  const card = document.createElement('div');
  card.className = 'catalog-item';

  const thumb = document.createElement('div');
  thumb.className = 'catalog-thumb';
  if (item.photoUrl) {
    const img = document.createElement('img');
    img.src = item.photoUrl; img.alt = ''; img.loading = 'lazy';
    thumb.appendChild(img);
  }

  const info = document.createElement('div');
  info.className = 'catalog-info';
  const name = document.createElement('div');
  name.className = 'catalog-name';
  name.textContent = item.name || '(sans nom)';
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  const bits = [`${item.priceHT || 0}€ HT`, `${item.priceTTC || 0}€ TTC`];
  if (type.hasCategory && item.category) bits.unshift(item.category);
  if (type.hasStock && item.stock != null) bits.push(`stock ${item.stock}`);
  meta.textContent = bits.join(' · ');
  info.append(name, meta);
  if (item.description) {
    const d = document.createElement('div');
    d.className = 'task-meta';
    d.textContent = item.description;
    info.appendChild(d);
  }

  const actions = document.createElement('div');
  actions.className = 'catalog-actions';
  const edit = document.createElement('button');
  edit.type = 'button'; edit.className = 'mini-btn'; edit.textContent = 'Modifier';
  edit.onclick = () => {
    if (card.nextElementSibling && card.nextElementSibling.classList.contains('catalog-form')) {
      card.nextElementSibling.remove(); return;
    }
    card.after(catalogItemForm(type, item));
  };
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'mini-btn danger'; del.textContent = 'Supprimer';
  armInlineConfirm(del, 'Confirmer la suppression', () => deleteCatalogItem(item.id));
  actions.append(edit, del);

  card.append(thumb, info, actions);
  return card;
}

function catalogField(label, name, value, inputType) {
  const wrap = document.createElement('label');
  wrap.className = 'form-row';
  const span = document.createElement('span');
  span.textContent = label;
  span.style.cssText = 'display:block;font-size:13px;margin-bottom:6px;font-weight:600;';
  const input = document.createElement('input');
  input.type = inputType || 'text';
  if (inputType === 'number') { input.min = '0'; input.step = '0.01'; }
  input.name = name;
  input.value = value == null ? '' : value;
  wrap.append(span, input);
  return wrap;
}

function catalogItemForm(type, existing) {
  const form = document.createElement('form');
  form.className = 'catalog-form';
  const vat = getPricing().vatRate;
  const get = n => form.querySelector(`[name="${n}"]`);

  const fName = catalogField('Nom', 'name', existing ? existing.name : '');
  const fDesc = catalogField('Description', 'description', existing ? existing.description : '');
  const fCat = type.hasCategory ? catalogField('Catégorie', 'category', existing ? existing.category : '') : null;
  const fHT = catalogField('Prix HT (€)', 'priceHT', existing ? existing.priceHT : '', 'number');
  const fTTC = catalogField('Prix TTC (€)', 'priceTTC', existing ? existing.priceTTC : '', 'number');
  const fStock = type.hasStock ? catalogField('Stock', 'stock', existing ? existing.stock : '', 'number') : null;
  const fPhoto = catalogField('Photo (URL, optionnel)', 'photoUrl', existing ? existing.photoUrl : '');

  form.append(fName, fDesc);
  if (fCat) form.append(fCat);
  const cols = document.createElement('div');
  cols.className = 'form-cols';
  cols.append(fHT, fTTC);
  form.append(cols);
  if (fStock) form.append(fStock);
  form.append(fPhoto);

  // TTC auto-calculé depuis le HT (modifiable ensuite).
  fHT.querySelector('input').addEventListener('input', e => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) get('priceTTC').value = Math.round(v * (1 + vat));
  });

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const save = document.createElement('button');
  save.type = 'submit'; save.className = 'btn primary'; save.textContent = existing ? 'Enregistrer' : 'Ajouter';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn ghost'; cancel.textContent = 'Annuler';
  cancel.onclick = () => form.remove();
  actions.append(save, cancel);
  form.append(actions);

  form.addEventListener('submit', e => {
    e.preventDefault();
    const data = {
      type: type.key,
      name: get('name').value.trim(),
      description: get('description').value.trim(),
      priceHT: Math.max(0, Number(get('priceHT').value) || 0),
      priceTTC: Math.max(0, Number(get('priceTTC').value) || 0),
      photoUrl: get('photoUrl').value.trim(),
      active: true,
    };
    if (type.hasCategory) data.category = get('category').value.trim();
    if (type.hasStock) data.stock = Math.max(0, Math.floor(Number(get('stock').value) || 0));
    if (!data.name) { setCatalogStatus('Le nom est obligatoire.', 'error'); return; }
    saveCatalogItem(existing ? existing.id : null, data, save);
  });
  return form;
}

async function saveCatalogItem(id, data, btn) {
  try {
    await withButtonLoading(btn, () => id
      ? withTimeout(updateDoc(doc(db, 'catalog', id), data), 15000)
      : withTimeout(addDoc(collection(db, 'catalog'), { ...data, createdAt: serverTimestamp() }), 15000));
    setCatalogStatus(id ? 'Article mis à jour.' : 'Article ajouté.', 'success');
    // onSnapshot reconstruit le catalogue (et retire le formulaire ouvert).
  } catch (error) {
    setCatalogStatus(`Enregistrement impossible : ${authErrorMessage(error)}`, 'error');
  }
}

async function deleteCatalogItem(id) {
  try {
    await withTimeout(deleteDoc(doc(db, 'catalog', id)), 15000);
    setCatalogStatus('Article supprimé.', 'success');
  } catch (error) {
    setCatalogStatus(`Suppression impossible : ${authErrorMessage(error)}`, 'error');
  }
}

// Prestataires et livreurs approuvés, pour les listes déroulantes d'assignation.
function subscribeTeamMembers() {
  membersUnsubs.forEach(unsub => unsub());
  membersUnsubs = [];
  ['prestataire', 'livreur'].forEach(role => {
    const unsub = onSnapshot(query(collection(db, 'users'), where('role', '==', role)), snapshot => {
      const all = snapshot.docs
        .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
        .sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));
      // Approuvés : dropdowns d'assignation + roster. Suspendus : roster
      // uniquement (pour réactivation), jamais proposés à l'assignation.
      const approved = all.filter(m => (m.accountStatus ?? 'approved') === 'approved');
      const suspendedList = all.filter(m => m.accountStatus === 'suspended');
      if (role === 'prestataire') { prestataires = approved; suspended.prestataire = suspendedList; }
      else { livreurs = approved; suspended.livreur = suspendedList; }
      renderAssignments();
    }, error => setAdminStatus(`Impossible de charger l’équipe : ${authErrorMessage(error)}`, 'error'));
    membersUnsubs.push(unsub);
  });
}

function buildMemberSelect(members, placeholder, annotate) {
  const select = document.createElement('select');
  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  select.appendChild(first);
  members.forEach(member => {
    const option = document.createElement('option');
    option.value = member.id;
    const suffix = annotate ? annotate(member) : '';
    option.textContent = suffix ? `${member.name || member.email} — ${suffix}` : (member.name || member.email);
    select.appendChild(option);
  });
  return select;
}

function appendAssignCard(container, booking, members, placeholder, noMembersNote, metaText, assignFn, annotate) {
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
  const select = buildMemberSelect(members, placeholder, annotate);
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
  renderAdminCalendar();
  renderRoster();
  renderCompta();
  renderTabBadges();
}

function renderRoster() {
  if (!roster) return;
  roster.innerHTML = '';
  roster.appendChild(buildRosterGroup('Prestataires', prestataires, 'prestataire'));
  roster.appendChild(buildRosterGroup('Livreurs', livreurs, 'livreur', suspended.livreur));
}

function buildRosterGroup(title, members, role, suspendedMembers = []) {
  const section = document.createElement('div');
  section.className = 'roster-group';
  const heading = document.createElement('div');
  heading.className = 'eyebrow';
  heading.textContent = `${title} · ${members.length}`;
  section.appendChild(heading);
  if (members.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = `Aucun ${role} approuvé pour le moment.`;
    section.appendChild(empty);
  } else {
    members.forEach(member => section.appendChild(buildRosterCard(member, role, false)));
  }
  if (suspendedMembers.length) {
    const subhead = document.createElement('div');
    subhead.className = 'roster-subhead';
    subhead.textContent = `Suspendus · ${suspendedMembers.length}`;
    section.appendChild(subhead);
    suspendedMembers.forEach(member => section.appendChild(buildRosterCard(member, role, true)));
  }
  return section;
}

// Charge + note d'un prestataire, calculées depuis les réservations en direct.
function prestataireStats(memberId) {
  let active = 0;
  let done = 0;
  let ratingSum = 0;
  let ratingCount = 0;
  latestBookings.forEach(booking => {
    if (booking.prestataireId !== memberId) return;
    if (['accepted', 'submitted', 'rejected'].includes(booking.status)) {
      active += 1;
    } else if (booking.status === 'verified') {
      done += 1;
      if (typeof booking.rating === 'number') { ratingSum += booking.rating; ratingCount += 1; }
    }
  });
  return { active, done, ratingCount, average: ratingCount ? ratingSum / ratingCount : null };
}

function livreurStats(memberId) {
  let active = 0;
  let done = 0;
  latestBookings.forEach(booking => {
    if (booking.livreurId !== memberId || booking.status === 'cancelled') return;
    if (booking.linenDone) done += 1;
    else active += 1;
  });
  return { active, done };
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

function buildRosterCard(member, role, isSuspended) {
  const card = document.createElement('div');
  card.className = 'task-card' + (isSuspended ? ' roster-suspended' : '');

  // Le nom ouvre la fiche détaillée du membre (contact, missions, actions).
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'task-title roster-name';
  name.textContent = (member.name || member.email) + (isSuspended ? ' · suspendu' : '');
  name.onclick = () => openMemberModal(member, role);
  card.appendChild(name);

  const stats = role === 'prestataire' ? prestataireStats(member.id) : livreurStats(member.id);
  const load = document.createElement('div');
  load.className = 'task-meta roster-load';
  load.textContent = role === 'prestataire'
    ? `${stats.active} mission(s) en cours · ${stats.done} confirmée(s)`
    : `${stats.active} tournée(s) à faire · ${stats.done} faite(s)`;
  card.appendChild(load);

  if (role === 'prestataire') {
    const ratingLine = document.createElement('div');
    ratingLine.className = 'task-meta roster-rating';
    if (stats.ratingCount === 0) {
      ratingLine.textContent = 'Aucune évaluation pour le moment';
    } else {
      ratingLine.appendChild(buildStaticStars(Math.round(stats.average)));
      const text = document.createElement('span');
      text.textContent = `${stats.average.toFixed(1)} / 5 · ${stats.ratingCount} avis`;
      ratingLine.appendChild(text);
    }
    card.appendChild(ratingLine);
  }
  return card;
}

// Liste des missions/tournées actives d'un membre (pour la fiche).
function memberActiveJobs(member, role) {
  if (role === 'prestataire') {
    return latestBookings
      .filter(b => b.prestataireId === member.id && ['accepted', 'submitted', 'rejected'].includes(b.status))
      .sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''));
  }
  return latestBookings
    .filter(b => b.livreurId === member.id && !b.linenDone && b.status !== 'cancelled' && b.status !== 'verified')
    .sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''));
}

function escCloseModal(event) {
  if (event.key === 'Escape') closeMemberModal();
}

function closeMemberModal() {
  const existing = document.getElementById('memberModal');
  if (existing) existing.remove();
  document.removeEventListener('keydown', escCloseModal);
}

function openMemberModal(member, role) {
  closeMemberModal();
  const isSuspended = member.accountStatus === 'suspended';
  const stats = role === 'prestataire' ? prestataireStats(member.id) : livreurStats(member.id);
  const jobs = memberActiveJobs(member, role);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'memberModal';
  overlay.onclick = event => { if (event.target === overlay) closeMemberModal(); };

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Fermer');
  closeBtn.textContent = '×';
  closeBtn.onclick = closeMemberModal;
  modal.appendChild(closeBtn);

  const eyebrow = document.createElement('div');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = (role === 'prestataire' ? 'Prestataire' : 'Livreur') + (isSuspended ? ' · suspendu' : '');
  modal.appendChild(eyebrow);
  const h = document.createElement('h2');
  h.textContent = member.name || member.email;
  modal.appendChild(h);

  // Contact
  const contact = document.createElement('div');
  contact.className = 'modal-contact';
  if (member.email) {
    const mail = document.createElement('a');
    mail.href = `mailto:${member.email}`;
    mail.textContent = member.email;
    contact.appendChild(mail);
  }
  if (member.phone) {
    const tel = document.createElement('a');
    tel.href = `tel:${member.phone}`;
    tel.textContent = member.phone;
    contact.appendChild(tel);
  }
  modal.appendChild(contact);

  // Charge + note
  const summary = document.createElement('div');
  summary.className = 'modal-summary';
  summary.textContent = role === 'prestataire'
    ? `${stats.active} mission(s) en cours · ${stats.done} confirmée(s)`
    : `${stats.active} tournée(s) à faire · ${stats.done} faite(s)`;
  modal.appendChild(summary);
  if (role === 'prestataire') {
    const ratingLine = document.createElement('div');
    ratingLine.className = 'modal-summary roster-rating';
    if (stats.ratingCount === 0) {
      ratingLine.textContent = 'Aucune évaluation pour le moment';
    } else {
      ratingLine.appendChild(buildStaticStars(Math.round(stats.average)));
      const text = document.createElement('span');
      text.textContent = `${stats.average.toFixed(1)} / 5 · ${stats.ratingCount} avis`;
      ratingLine.appendChild(text);
    }
    modal.appendChild(ratingLine);
  }

  // Missions/tournées en cours
  const jobsHead = document.createElement('div');
  jobsHead.className = 'eyebrow';
  jobsHead.style.marginTop = '20px';
  jobsHead.textContent = role === 'prestataire' ? 'Missions en cours' : 'Tournées en cours';
  modal.appendChild(jobsHead);
  if (jobs.length === 0) {
    const none = document.createElement('div');
    none.className = 'empty-state';
    none.textContent = 'Aucune en cours.';
    modal.appendChild(none);
  } else {
    jobs.forEach(job => {
      const row = document.createElement('div');
      row.className = 'task-meta';
      row.textContent = `${formatShortDate(job.scheduledDate)} · ${job.propertyAddress || job.propertyId} · ${formatBookingStatus(job.status)}`;
      modal.appendChild(row);
    });
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  if (isSuspended) {
    const reactivate = document.createElement('button');
    reactivate.className = 'btn primary';
    reactivate.type = 'button';
    reactivate.textContent = 'Réactiver ce membre';
    reactivate.onclick = () => setMemberStatus(member, 'approved', `${member.name || member.email} a été réactivé(e).`);
    actions.appendChild(reactivate);
  } else {
    if (jobs.length) {
      const nudge = document.createElement('div');
      nudge.className = 'task-meta';
      nudge.style.color = 'var(--danger-ink)';
      nudge.textContent = `${jobs.length} intervention(s) en cours lui reste(nt) attribuée(s) : pensez à les réattribuer après le retrait.`;
      modal.appendChild(nudge);
    }
    const remove = document.createElement('button');
    remove.className = 'btn ghost danger';
    remove.type = 'button';
    remove.textContent = 'Retirer de l’équipe';
    armInlineConfirm(remove, 'Confirmer le retrait', () =>
      setMemberStatus(member, 'suspended', `${member.name || member.email} a été retiré(e) de l’équipe.`));
    actions.appendChild(remove);
  }
  modal.appendChild(actions);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', escCloseModal);
  closeBtn.focus();
}

async function setMemberStatus(member, status, successMessage) {
  try {
    await withTimeout(updateDoc(doc(db, 'users', member.id), { accountStatus: status }), 15000);
    setAdminStatus(successMessage, 'success');
    closeMemberModal();
  } catch (e) {
    setAdminStatus(`Impossible de mettre à jour ce membre : ${authErrorMessage(e)}`, 'error');
  }
}

function renderAdminCalendar() {
  if (!adminCalendar) return;
  adminCalendar.innerHTML = '';
  const monthLabel = adminCalMonthDate.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  adminCalMonth.textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);

  ['L', 'M', 'M', 'J', 'V', 'S', 'D'].forEach(label => {
    const dow = document.createElement('div');
    dow.className = 'acal-dow';
    dow.textContent = label;
    adminCalendar.appendChild(dow);
  });

  const year = adminCalMonthDate.getFullYear();
  const month = adminCalMonthDate.getMonth();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Réservations du mois (hors annulées), groupées par date.
  const byDate = {};
  latestBookings.forEach(booking => {
    if (!booking.scheduledDate || booking.status === 'cancelled') return;
    (byDate[booking.scheduledDate] = byDate[booking.scheduledDate] || []).push(booking);
  });

  const mondayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let i = 0; i < mondayOffset; i += 1) {
    const filler = document.createElement('div');
    filler.className = 'acal-cell empty';
    adminCalendar.appendChild(filler);
  }

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum += 1) {
    const day = new Date(year, month, dayNum);
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'acal-cell'
      + (day.getTime() === today.getTime() ? ' today' : '')
      + (day < today ? ' past' : '');
    const num = document.createElement('div');
    num.className = 'acal-num';
    num.textContent = dayNum;
    cell.appendChild(num);

    const events = (byDate[iso] || [])
      .slice()
      .sort((a, b) => (CAL_STATUS_ORDER[a.status] ?? 9) - (CAL_STATUS_ORDER[b.status] ?? 9));
    const dayHasUrgent = events.some(bookingIsUrgent);
    if (events.length) {
      cell.classList.add('has-events');
      if (dayHasUrgent) cell.classList.add('has-urgent');
      if (iso === selectedCalDay) cell.classList.add('sel');
      cell.setAttribute('role', 'button');
      cell.tabIndex = 0;
      cell.setAttribute('aria-label', `${dayNum} — ${events.length} réservation(s)${dayHasUrgent ? ', dont une non assignée à traiter' : ''}`);
      const open = () => { selectedCalDay = iso; renderAdminCalendar(); };
      cell.onclick = open;
      cell.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    }
    events.forEach(booking => {
      const urgent = bookingIsUrgent(booking);
      const ev = document.createElement('span');
      ev.className = `acal-event ${booking.status}` + (urgent ? ' urgent' : '');
      ev.textContent = (urgent ? '⚠ ' : '') + (booking.propertyAddress || 'Réservation');
      const who = booking.prestataireId ? prestataireName(booking.prestataireId) : 'non assignée';
      ev.title = `${booking.propertyAddress || 'Réservation'} · ${booking.serviceType === 'deep' ? 'En profondeur' : 'Normal'} · ${formatBookingStatus(booking.status)} · ${who}${booking.kitCount ? ` · ${booking.kitCount} kit(s)` : ''} · ${booking.price}€${urgent ? ' · à assigner sous 3 jours' : ''}`;
      cell.appendChild(ev);
    });
    adminCalendar.appendChild(cell);
  }

  renderDayPanel();
}

// Panneau « réservations du jour » sous le calendrier : au clic sur une date,
// liste chaque réservation avec l'action pertinente (assigner / vérifier).
function renderDayPanel() {
  const panel = document.getElementById('calDayPanel');
  if (!panel) return;
  panel.innerHTML = '';
  if (!selectedCalDay) return;
  const dayBookings = latestBookings
    .filter(b => b.scheduledDate === selectedCalDay && b.status !== 'cancelled')
    .sort((a, b) => (CAL_STATUS_ORDER[a.status] ?? 9) - (CAL_STATUS_ORDER[b.status] ?? 9));
  const heading = document.createElement('div');
  heading.className = 'eyebrow';
  heading.textContent = `Réservations du ${formatShortDate(selectedCalDay)}`;
  panel.appendChild(heading);
  if (dayBookings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Aucune réservation ce jour.';
    panel.appendChild(empty);
    return;
  }
  dayBookings.forEach(booking => {
    const row = document.createElement('div');
    row.className = 'task-card';
    const top = document.createElement('div');
    top.className = 'task-top';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = booking.propertyAddress || booking.propertyId;
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const who = booking.prestataireId ? prestataireName(booking.prestataireId) : 'non assignée';
    meta.textContent = `${booking.serviceType === 'deep' ? 'En profondeur' : 'Normal'}${booking.surface ? ` · ${booking.surface} m²` : ''} · ${who} · ${booking.price}€`;
    left.appendChild(title);
    left.appendChild(meta);
    const pill = document.createElement('div');
    pill.className = `status-pill ${booking.status}`;
    pill.textContent = formatBookingStatus(booking.status);
    top.appendChild(left);
    top.appendChild(pill);
    row.appendChild(top);
    if (bookingIsUrgent(booking)) {
      const warn = document.createElement('div');
      warn.className = 'task-meta cal-urgent-note';
      warn.textContent = '⚠ Non assignée — échéance sous 3 jours';
      row.appendChild(warn);
    }
    if (booking.status === 'pending' || booking.status === 'submitted') {
      const btn = document.createElement('button');
      btn.className = 'btn ghost';
      btn.type = 'button';
      btn.textContent = booking.status === 'pending' ? 'Assigner' : 'Vérifier';
      btn.style.marginTop = '12px';
      btn.onclick = () => focusCalendarBooking(booking);
      row.appendChild(btn);
    }
    if (['pending', 'accepted', 'submitted', 'rejected'].includes(booking.status)) {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn ghost danger';
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Annuler la mission';
      cancelBtn.style.marginTop = '12px';
      cancelBtn.style.marginLeft = (booking.status === 'pending' || booking.status === 'submitted') ? '10px' : '0';
      armInlineConfirm(cancelBtn, 'Confirmer l’annulation', () => cancelBooking(booking, cancelBtn));
      row.appendChild(cancelBtn);

      const reBtn = document.createElement('button');
      reBtn.className = 'btn ghost';
      reBtn.type = 'button';
      reBtn.textContent = 'Reprogrammer';
      reBtn.style.cssText = 'margin-top:12px; margin-left:10px;';
      reBtn.onclick = () => openReschedule(booking, row, reBtn);
      row.appendChild(reBtn);
    }
    panel.appendChild(row);
  });
}

// Admin : annuler une mission (toute étape). Notifie le client au mieux.
async function cancelBooking(booking, button) {
  try {
    await withButtonLoading(button, () =>
      withTimeout(updateDoc(doc(db, 'bookings', booking.id), { status: 'cancelled' }), 15000));
    try {
      const clientSnap = await getDoc(doc(db, 'users', booking.clientId));
      if (clientSnap.exists() && clientSnap.data().email) {
        queueEmail({
          to: clientSnap.data().email,
          subject: `CleanFlow — réservation annulée · Réf ${booking.id.slice(0, 6).toUpperCase()}`,
          text: `Votre ménage du ${formatShortDate(booking.scheduledDate)} (${booking.propertyAddress || 'votre bien'}) a été annulé par l'équipe CleanFlow. Contactez-nous pour reprogrammer.`,
        });
      }
    } catch (e) { /* la notification ne doit pas bloquer l'annulation */ }
    setAdminStatus('Mission annulée. Le client est notifié par email.', 'success');
  } catch (e) {
    setAdminStatus(`Impossible d’annuler la mission : ${authErrorMessage(e)}`, 'error');
  }
}

// Admin : reprogrammer une mission (changer sa date). Notifie le client au mieux.
function openReschedule(booking, row, triggerBtn) {
  if (row.querySelector('.reschedule-box')) { row.querySelector('.reschedule-box').remove(); return; }
  const box = document.createElement('div');
  box.className = 'reschedule-box';
  box.style.cssText = 'margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;';
  const input = document.createElement('input');
  input.type = 'date';
  input.value = booking.scheduledDate || '';
  input.min = isoInDays(0); // aujourd'hui en date locale (cohérent avec le calendrier)
  input.style.maxWidth = '190px';
  const save = document.createElement('button');
  save.className = 'btn primary';
  save.type = 'button';
  save.textContent = 'Enregistrer la date';
  save.onclick = async () => {
    const newDate = input.value;
    if (!newDate) { setAdminStatus('Choisissez une date.', 'error'); return; }
    if (newDate === booking.scheduledDate) { box.remove(); return; }
    try {
      await withButtonLoading(save, () =>
        withTimeout(updateDoc(doc(db, 'bookings', booking.id), { scheduledDate: newDate }), 15000));
      try {
        const clientSnap = await getDoc(doc(db, 'users', booking.clientId));
        if (clientSnap.exists() && clientSnap.data().email) {
          queueEmail({
            to: clientSnap.data().email,
            subject: `CleanFlow — ménage reprogrammé · Réf ${booking.id.slice(0, 6).toUpperCase()}`,
            text: `Votre ménage (${booking.propertyAddress || 'votre bien'}) a été reprogrammé au ${formatShortDate(newDate)} par l'équipe CleanFlow.`,
          });
        }
      } catch (e) { /* la notification ne doit pas bloquer la reprogrammation */ }
      setAdminStatus(`Mission reprogrammée au ${formatShortDate(newDate)}. Le client est notifié.`, 'success');
    } catch (e) {
      setAdminStatus(`Impossible de reprogrammer : ${authErrorMessage(e)}`, 'error');
    }
  };
  box.appendChild(input);
  box.appendChild(save);
  row.appendChild(box);
  input.focus();
}

// Comptabilité : montant de chaque mission + ajustements bonus/malus discrétionnaires.
// Détail financier d'une mission. CleanFlow encaisse tout (revenu client) et
// verse au prestataire une rémunération (base fixée par l'admin) + bonus/malus.
function comptaLine(booking) {
  const price = Number(booking.price) || 0;
  const prestation = Number(booking.prestationPrice) || 0;
  const travel = Number(booking.travelFee) || 0;
  const amenities = Number(booking.amenitiesPrice) || 0;
  const extras = Number(booking.extrasHT) || 0;
  // Les kits de bienvenue sont le reliquat (prix − prestation − amenities − suppléments − déplacement).
  const kits = Math.max(0, price - prestation - amenities - extras - travel);
  const base = Number(booking.prestatairePay) || 0;
  const adj = Number(booking.adjustment) || 0;
  const payout = base + adj;
  return { price, prestation, travel, kits, amenities, extras, base, adj, payout, margin: price - payout };
}

// Décomposition « ce que coûte quoi » d'une mission, pour que l'admin sache
// comment le prix client se répartit (il fixe ensuite lui-même la paie).
function comptaBreakdownText(booking) {
  const l = comptaLine(booking);
  const rooms = Number(booking.bedrooms != null ? booking.bedrooms : booking.kitCount) || 0;
  const hrs = booking.hours ? ` (${String(booking.hours).replace('.', ',')} h)` : '';
  const parts = [`prestation ${l.prestation}€${hrs}`];
  if (l.kits) parts.push(`kits ${l.kits}€${rooms ? ` (${rooms} chambre${rooms > 1 ? 's' : ''})` : ''}`);
  parts.push(`amenities ${l.amenities}€`);
  if (l.extras) parts.push(`suppléments ${l.extras}€`);
  if (l.travel) parts.push(`déplacement ${l.travel}€`);
  return parts.join(' · ');
}

function isoOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Bornes ISO (incluses) de la période sélectionnée, ou null pour « tout ».
function comptaBounds() {
  const now = new Date();
  if (comptaRange === 'all') return null;
  if (comptaRange === 'custom') {
    return { from: comptaCustom.from || '0000-01-01', to: comptaCustom.to || '9999-12-31' };
  }
  if (comptaRange === 'week') {
    const diffToMon = (now.getDay() + 6) % 7; // lundi = début de semaine
    const mon = new Date(now); mon.setDate(now.getDate() - diffToMon);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { from: isoOf(mon), to: isoOf(sun) };
  }
  if (comptaRange === 'year') {
    return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
  }
  // mois en cours (défaut)
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: isoOf(first), to: isoOf(last) };
}

function renderComptaFilter(bounds) {
  const host = document.getElementById('comptaFilter');
  if (!host) return;
  host.innerHTML = '';
  host.className = 'compta-range';

  const seg = document.createElement('div');
  seg.className = 'seg';
  [['week', 'Semaine'], ['month', 'Mois'], ['year', 'Année'], ['all', 'Tout'], ['custom', 'Personnalisé']]
    .forEach(([value, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (comptaRange === value ? ' active' : '');
      b.textContent = label;
      b.onclick = () => { comptaRange = value; renderCompta(); };
      seg.appendChild(b);
    });
  host.appendChild(seg);

  if (comptaRange === 'custom') {
    const wrap = document.createElement('div');
    wrap.className = 'seg-custom';
    const from = document.createElement('input');
    from.type = 'date'; from.value = comptaCustom.from;
    from.setAttribute('aria-label', 'Du');
    const to = document.createElement('input');
    to.type = 'date'; to.value = comptaCustom.to;
    to.setAttribute('aria-label', 'Au');
    from.onchange = () => { comptaCustom.from = from.value; renderCompta(); };
    to.onchange = () => { comptaCustom.to = to.value; renderCompta(); };
    const dash = document.createElement('span');
    dash.textContent = '→';
    wrap.appendChild(from); wrap.appendChild(dash); wrap.appendChild(to);
    host.appendChild(wrap);
  } else if (bounds) {
    const lbl = document.createElement('div');
    lbl.className = 'seg-period';
    lbl.textContent = `${formatShortDate(bounds.from)} — ${formatShortDate(bounds.to)}`;
    host.appendChild(lbl);
  }

  // Deuxième ligne : filtrer par prestataire et rechercher un bien/une mission.
  const drill = document.createElement('div');
  drill.className = 'seg-drill';
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'Filtrer par prestataire');
  const optAll = document.createElement('option');
  optAll.value = ''; optAll.textContent = 'Tous les prestataires';
  sel.appendChild(optAll);
  prestataires.forEach(p => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name || p.email || p.id;
    if (p.id === comptaPrestataire) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => { comptaPrestataire = sel.value; renderComptaResults(); };
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Rechercher un bien / une adresse';
  search.value = comptaSearch;
  search.setAttribute('aria-label', 'Rechercher une mission');
  search.oninput = () => { comptaSearch = search.value; renderComptaResults(); };
  drill.appendChild(sel);
  drill.appendChild(search);
  host.appendChild(drill);
}

function renderCompta() {
  renderComptaFilter(comptaBounds());
  renderComptaResults();
}

// Totaux + liste seuls (sans reconstruire la barre de filtres), pour que la
// saisie dans le champ de recherche ne perde pas le focus à chaque frappe.
function renderComptaResults() {
  const totals = document.getElementById('comptaTotals');
  const list = document.getElementById('comptaList');
  if (!totals || !list) return;
  const bounds = comptaBounds();
  const q = comptaSearch.trim().toLowerCase();
  const rows = latestBookings
    .filter(b => b.status !== 'cancelled')
    .filter(b => !bounds || (b.scheduledDate && b.scheduledDate >= bounds.from && b.scheduledDate <= bounds.to))
    .filter(b => !comptaPrestataire || b.prestataireId === comptaPrestataire)
    .filter(b => !q || `${b.propertyAddress || b.propertyId || ''}`.toLowerCase().includes(q))
    .sort((a, b) => (b.scheduledDate || '').localeCompare(a.scheduledDate || ''));
  const agg = rows.reduce((acc, b) => {
    const l = comptaLine(b);
    acc.revenue += l.price;
    acc.payout += l.payout;
    return acc;
  }, { revenue: 0, payout: 0 });
  const margin = agg.revenue - agg.payout;

  const stat = (value, label) => {
    const d = document.createElement('div');
    d.className = 'stat';
    const b = document.createElement('b');
    b.textContent = value;
    const s = document.createElement('span');
    s.textContent = label;
    d.appendChild(b);
    d.appendChild(s);
    return d;
  };
  totals.innerHTML = '';
  totals.appendChild(stat(`${rows.length}`, 'Missions'));
  totals.appendChild(stat(`${agg.revenue}€`, 'Revenus clients'));
  totals.appendChild(stat(`${agg.payout}€`, 'Versé aux prestataires'));
  totals.appendChild(stat(`${margin}€`, 'Marge CleanFlow'));

  list.innerHTML = '';
  if (rows.length === 0) {
    const filtered = comptaPrestataire || comptaSearch.trim();
    list.innerHTML = `<div class="empty-state">Aucune mission ${filtered ? 'pour ce filtre' : (comptaRange === 'all' ? 'à comptabiliser' : 'sur cette période')}.</div>`;
    return;
  }
  rows.forEach(booking => list.appendChild(buildComptaRow(booking)));
}

function buildComptaRow(booking) {
  const l = comptaLine(booking);
  const row = document.createElement('div');
  row.className = 'task-card';

  const top = document.createElement('div');
  top.className = 'task-top';
  const left = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = booking.propertyAddress || booking.propertyId;
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  const who = booking.prestataireId ? prestataireName(booking.prestataireId) : 'non assignée';
  meta.textContent = `${formatShortDate(booking.scheduledDate)} · ${who} · ${formatBookingStatus(booking.status)}`;
  left.appendChild(title);
  left.appendChild(meta);
  const amount = document.createElement('div');
  amount.className = 'compta-amount';
  amount.textContent = `${l.price}€`;
  top.appendChild(left);
  top.appendChild(amount);
  row.appendChild(top);

  // Revenu client (d'où vient l'argent).
  const rev = document.createElement('div');
  rev.className = 'task-meta';
  rev.textContent = `Revenu : ${comptaBreakdownText(booking)}`;
  row.appendChild(rev);

  // Ce qui est versé au prestataire (base + bonus/malus).
  const pay = document.createElement('div');
  pay.className = 'task-meta';
  if (!l.base && !l.adj) {
    pay.textContent = 'Prestataire : rémunération à définir';
  } else {
    const adjPart = l.adj ? ` ${l.adj > 0 ? '+' : '−'}${Math.abs(l.adj)}€ (${l.adj > 0 ? 'bonus' : 'malus'})` : '';
    const badge = document.createElement('span');
    badge.className = l.adj < 0 ? 'adj-malus' : 'adj-bonus';
    badge.textContent = `Prestataire : ${l.base}€${adjPart} = ${l.payout}€`;
    pay.appendChild(badge);
    if (booking.adjustmentNote) pay.appendChild(document.createTextNode(` · ${booking.adjustmentNote}`));
  }
  row.appendChild(pay);

  // Marge CleanFlow.
  const marginLine = document.createElement('div');
  marginLine.className = 'task-meta roster-load';
  marginLine.textContent = `Marge CleanFlow : ${l.margin}€`;
  row.appendChild(marginLine);

  const editBtn = document.createElement('button');
  editBtn.className = 'mini-btn';
  editBtn.type = 'button';
  editBtn.style.marginTop = '10px';
  editBtn.textContent = (l.base || l.adj) ? 'Modifier la rémunération' : 'Définir la rémunération';
  editBtn.onclick = () => {
    const existing = row.querySelector('.adj-box');
    if (existing) { existing.remove(); return; }
    const box = document.createElement('div');
    box.className = 'adj-box';
    box.style.cssText = 'margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;';
    const baseIn = document.createElement('input');
    baseIn.type = 'number';
    baseIn.step = '1';
    baseIn.placeholder = 'Rémunération (€)';
    baseIn.value = l.base || '';
    baseIn.style.maxWidth = '150px';
    const adjIn = document.createElement('input');
    adjIn.type = 'number';
    adjIn.step = '1';
    adjIn.placeholder = '+ bonus / − malus (€)';
    adjIn.value = l.adj || '';
    adjIn.style.maxWidth = '160px';
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.placeholder = 'Motif (optionnel)';
    noteInput.value = booking.adjustmentNote || '';
    noteInput.style.maxWidth = '200px';
    const save = document.createElement('button');
    save.className = 'btn primary';
    save.type = 'button';
    save.textContent = 'Enregistrer';
    save.onclick = async () => {
      const payload = {
        prestatairePay: Math.round(Number(baseIn.value) || 0),
        adjustment: Math.round(Number(adjIn.value) || 0),
        adjustmentNote: noteInput.value.trim(),
      };
      try {
        await withButtonLoading(save, () =>
          withTimeout(updateDoc(doc(db, 'bookings', booking.id), payload), 15000));
        setAdminStatus('Rémunération enregistrée.', 'success');
      } catch (e) {
        setAdminStatus(`Impossible d’enregistrer : ${authErrorMessage(e)}`, 'error');
      }
    };
    box.appendChild(baseIn);
    box.appendChild(adjIn);
    box.appendChild(noteInput);
    box.appendChild(save);
    row.appendChild(box);
    baseIn.focus();
  };
  row.appendChild(editBtn);
  return row;
}

// Depuis le calendrier, amener l'admin à l'action pertinente pour la réservation.
async function focusCalendarBooking(booking) {
  if (booking.status === 'submitted') {
    const queued = bookingQueueData.find(b => b.id === booking.id);
    if (queued) {
      activateTab('verify');
      selectedBooking = queued;
      try { await refreshBookingDetail(); } catch (e) { /* le détail se rechargera au prochain snapshot */ }
      renderBookingQueue();
      renderBookingDetail();
      bookingTitle.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }
  if (booking.status === 'pending' && missionsToAssign) {
    activateTab('assign');
    missionsToAssign.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
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
  // Classement pour l'assignation : mieux notés d'abord, puis les moins
  // chargés — pour répartir le travail sans sacrifier la qualité.
  const rankedPrestataires = prestataires.slice().sort((a, b) => {
    const sa = prestataireStats(a.id);
    const sb = prestataireStats(b.id);
    const ra = sa.average ?? -1;
    const rb = sb.average ?? -1;
    if (rb !== ra) return rb - ra;
    if (sa.active !== sb.active) return sa.active - sb.active;
    return (a.name || a.email).localeCompare(b.name || b.email);
  });
  const prestataireAnnotate = member => {
    const s = prestataireStats(member.id);
    const ratingPart = s.average != null ? `★${s.average.toFixed(1)} (${s.ratingCount})` : 'non noté';
    return `${ratingPart} · ${s.active} en cours`;
  };

  pending.forEach(booking => {
    const metaText = `${formatShortDate(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}${booking.surface ? ` · ${booking.surface} m²` : ''}${booking.kitCount ? ` · ${booking.kitCount} kit(s)` : ''} · ${booking.price}€`;
    appendAssignCard(missionsToAssign, booking, rankedPrestataires, 'Choisir un prestataire…',
      'Aucun prestataire approuvé. Approuvez d’abord une demande d’accès.', metaText,
      async (prestataireId, assignBtn) => {
        if (!prestataireId) { setAdminStatus('Choisissez un prestataire avant d’assigner.', 'error'); return; }
        const member = prestataires.find(p => p.id === prestataireId);
        try {
          await withButtonLoading(assignBtn, () =>
            withTimeout(updateDoc(doc(db, 'bookings', booking.id), { prestataireId, status: 'accepted' }), 15000));
          if (member?.email) {
            queueEmail({
              to: member.email,
              subject: `CleanFlow — nouvelle mission assignée · Réf ${booking.id.slice(0, 6).toUpperCase()}`,
              text: `${booking.propertyAddress || 'Mission'} · ${formatShortDate(booking.scheduledDate)} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}. Retrouvez-la dans votre interface prestataire.`,
            });
          }
          setAdminStatus(`Mission assignée à ${member?.name || member?.email || 'ce prestataire'}.`, 'success');
        } catch (e) {
          setAdminStatus(`Impossible d’assigner la mission : ${authErrorMessage(e)}`, 'error');
        }
      }, prestataireAnnotate);
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
  const rankedLivreurs = livreurs.slice().sort((a, b) => {
    const sa = livreurStats(a.id);
    const sb = livreurStats(b.id);
    if (sa.active !== sb.active) return sa.active - sb.active;
    return (a.name || a.email).localeCompare(b.name || b.email);
  });
  const livreurAnnotate = member => `${livreurStats(member.id).active} à faire`;

  needing.forEach(booking => {
    const metaText = `${formatShortDate(booking.scheduledDate)}${booking.kitCount ? ` · ${booking.kitCount} kit(s)` : ''} · dépôt kits / linge propre + récupération`;
    appendAssignCard(kitsToAssign, booking, rankedLivreurs, 'Choisir un livreur…',
      'Aucun livreur approuvé. Approuvez d’abord une demande d’accès.', metaText,
      async (livreurId, assignBtn) => {
        if (!livreurId) { setAdminStatus('Choisissez un livreur avant d’assigner.', 'error'); return; }
        const member = livreurs.find(l => l.id === livreurId);
        try {
          await withButtonLoading(assignBtn, () =>
            withTimeout(updateDoc(doc(db, 'bookings', booking.id), { livreurId }), 15000));
          if (member?.email) {
            queueEmail({
              to: member.email,
              subject: `CleanFlow — nouvelle tournée assignée · Réf ${booking.id.slice(0, 6).toUpperCase()}`,
              text: `${booking.propertyAddress || 'Tournée'} · ${formatShortDate(booking.scheduledDate)} · dépôt des kits / linge propre et récupération. Retrouvez-la dans votre interface livreur.`,
            });
          }
          setAdminStatus(`Tournée assignée à ${member?.name || member?.email || 'ce livreur'}.`, 'success');
        } catch (e) {
          setAdminStatus(`Impossible d’assigner la tournée : ${authErrorMessage(e)}`, 'error');
        }
      }, livreurAnnotate);
  });
}

function subscribeOpenIncidents() {
  if (incidentsUnsub) incidentsUnsub();
  const openQuery = query(collection(db, 'incidents'), where('status', '==', 'open'));
  incidentsUnsub = onSnapshot(openQuery, snapshot => {
    const incidents = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => (b.reportedAt?.toMillis?.() || 0) - (a.reportedAt?.toMillis?.() || 0));
    openIncidentsCount = incidents.length;
    renderOpenIncidents(incidents);
    renderTabBadges();
  }, error => setAdminStatus(`Impossible de charger les incidents : ${authErrorMessage(error)}`, 'error'));
}

function subscribeClientMessages() {
  if (messagesUnsub) messagesUnsub();
  const openMsgQuery = query(collection(db, 'messages'), where('status', '==', 'open'));
  messagesUnsub = onSnapshot(openMsgQuery, snapshot => {
    const messages = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    openMessagesCount = messages.length;
    renderClientMessages(messages);
    renderTabBadges();
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
          withTimeout(updateDoc(doc(db, 'messages', message.id), { status: 'resolved' }), 15000));
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
          withTimeout(updateDoc(doc(db, 'incidents', incident.id), { status: 'resolved' }), 15000));
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

// Décomposition du prix client d'une mission dans la vue Vérification :
// l'admin voit « ce que coûte quoi » avant de fixer la paie du prestataire.
function renderBookingCost(booking) {
  if (!bookingCost) return;
  const l = comptaLine(booking);
  const rooms = Number(booking.bedrooms != null ? booking.bedrooms : booking.kitCount) || 0;
  const hstr = booking.hours ? `${String(booking.hours).replace('.', ',')} h · ` : '';
  const rows = [[`Prestation · ${hstr}${booking.surface ? `${booking.surface} m²` : ''}`.replace(/· $/, ''), l.prestation]];
  if (l.kits) rows.push([`Kits de bienvenue${rooms ? ` · ${rooms} chambre${rooms > 1 ? 's' : ''}` : ''}`, l.kits]);
  rows.push(['Amenities (consommables)', l.amenities, '']);
  (booking.extras || []).forEach(e => {
    rows.push([`${e.name || 'Supplément'}${e.qty > 1 ? ` × ${e.qty}` : ''}`, (Number(e.priceHT) || 0) * (Number(e.qty) || 0), '']);
  });
  if (l.travel) rows.push(['Frais de déplacement', l.travel, '']);
  // HT → TVA → TTC (TVA = pass-through, hors marge).
  const rate = getPricing().vatRate;
  const vat = Math.round(l.price * rate);
  rows.push(['Total HT', l.price, 'pb-total']);
  rows.push([`TVA (${Math.round(rate * 100)} %)`, vat, '']);
  rows.push(['Total TTC (payé par le client)', l.price + vat, 'pb-warn']);
  bookingCost.classList.remove('hidden');
  bookingCost.innerHTML = rows
    .map(r => `<div class="pb-line ${r[2] || ''}"><span></span><b>${r[1]}€</b></div>`)
    .join('');
  bookingCost.querySelectorAll('.pb-line span').forEach((span, i) => { span.textContent = rows[i][0]; });
}

function renderBookingDetail() {
  if (!selectedBooking) {
    bookingTitle.textContent = 'Aucun dossier sélectionné';
    bookingMeta.textContent = 'Sélectionnez un dossier dans la file pour contrôler les photos.';
    if (bookingCost) { bookingCost.classList.add('hidden'); bookingCost.innerHTML = ''; }
    photoGrid.innerHTML = '';
    incidentList.innerHTML = '';
    verifyBtn.disabled = true;
    rejectBtn.disabled = true;
    if (devisBtn) devisBtn.disabled = true;
    return;
  }
  if (devisBtn) {
    devisBtn.disabled = false;
    devisBtn.onclick = () => openDevisDocument(selectedBooking, { name: selectedBooking.clientName || '', email: selectedBooking.clientEmail || '' });
  }

  bookingTitle.textContent = selectedBooking.propertyAddress || selectedBooking.propertyId;
  bookingMeta.textContent = `${selectedBooking.clientEmail || ''} · ${formatShortDate(selectedBooking.scheduledDate)} · ${selectedBooking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}${selectedBooking.surface ? ` · ${selectedBooking.surface} m²` : ''}${selectedBooking.kitCount ? ` · ${selectedBooking.kitCount} kit(s)` : ''} · ${selectedBooking.price}€`;
  renderBookingCost(selectedBooking);
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
    await withTimeout(updateDoc(doc(db, 'bookings', selectedBooking.id), update), 15000);
    if (status === 'verified' && selectedBooking.photos) {
      const batch = writeBatch(db);
      Object.values(selectedBooking.photos).forEach(photo => {
        batch.update(doc(db, 'photos', photo.id), {
          verified: true,
          verifiedBy: currentUser.uid,
          verifiedAt: serverTimestamp(),
        });
      });
      await withTimeout(batch.commit(), 15000);
    }
    if (status === 'verified' && selectedBooking.clientEmail) {
      queueEmail({
        to: selectedBooking.clientEmail,
        subject: `CleanFlow — votre ménage du ${formatShortDate(selectedBooking.scheduledDate)} est confirmé ✓`,
        text: `Bonne nouvelle : le ménage de ${selectedBooking.propertyAddress || 'votre bien'} a été réalisé, son dossier photo a été contrôlé et validé par l’équipe CleanFlow. Retrouvez le détail dans votre espace client.`,
      });
    }
    if (status === 'rejected' && selectedBooking.prestataireId) {
      try {
        const prestataireSnap = await getDoc(doc(db, 'users', selectedBooking.prestataireId));
        if (prestataireSnap.exists() && prestataireSnap.data().email) {
          queueEmail({
            to: prestataireSnap.data().email,
            subject: `CleanFlow — dossier à corriger · Réf ${selectedBooking.id.slice(0, 6).toUpperCase()}`,
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
    if (pricingUnsub) pricingUnsub();
    if (catalogUnsub) catalogUnsub();
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
    refreshQueue();
    subscribeAccessRequests();
    subscribeStats();
    subscribeTeamMembers();
    subscribeOpenIncidents();
    subscribeClientMessages();
    subscribePricing();
    subscribeCatalog();
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

if (adminTabs) {
  adminTabs.addEventListener('click', event => {
    const btn = event.target.closest('.tab');
    if (!btn) return;
    activateTab(btn.dataset.tab);
    adminTabs.scrollIntoView({ block: 'start' });
  });
}

const pricingFormEl = document.getElementById('pricingForm');
if (pricingFormEl) {
  pricingFormEl.addEventListener('submit', event => {
    event.preventDefault();
    savePricing(collectPricingFromForm());
  });
}

adminCalPrev.addEventListener('click', () => {
  adminCalMonthDate = new Date(adminCalMonthDate.getFullYear(), adminCalMonthDate.getMonth() - 1, 1);
  selectedCalDay = null;
  renderAdminCalendar();
});
adminCalNext.addEventListener('click', () => {
  adminCalMonthDate = new Date(adminCalMonthDate.getFullYear(), adminCalMonthDate.getMonth() + 1, 1);
  selectedCalDay = null;
  renderAdminCalendar();
});

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
        withTimeout(updateDoc(doc(db, 'users', req.id), { accountStatus: 'approved' }), 15000));
      setTeamStatus(`Accès ${req.role} approuvé pour ${req.name}. La personne peut maintenant se connecter.`, 'success');
    } catch (e) {
      setTeamStatus('Impossible d’approuver cette demande.', 'error');
    }
  };
  const refuseBtn = document.createElement('button');
  refuseBtn.className = 'btn ghost danger';
  refuseBtn.type = 'button';
  refuseBtn.textContent = 'Refuser';
  armInlineConfirm(refuseBtn, 'Confirmer le refus', async () => {
    try {
      await withButtonLoading(refuseBtn, () =>
        withTimeout(updateDoc(doc(db, 'users', req.id), { accountStatus: 'rejected' }), 15000));
      setTeamStatus(`Demande de ${req.name} refusée. Ce compte n’a accès à aucune interface.`, 'success');
    } catch (e) {
      setTeamStatus('Impossible de refuser cette demande.', 'error');
    }
  });
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
    accessRequestCount = requests.length;
    renderAccessRequests(requests);
    renderTabBadges();
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
