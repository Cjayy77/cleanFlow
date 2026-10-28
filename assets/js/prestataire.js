// Zebramoon, interface prestataire : missions disponibles, photos, incidents.
import {
  auth,
  db,
  storage,
  ROLE_PRESTATAIRE,
  PHOTO_SLOTS,
  EXIGENCE_PHASES,
  loadUserDoc,
  loadPhotoDocs,
  uploadBookingImage,
  loadExigencesForProperty,
  loadExigenceAnswers,
  saveExigenceYesNo,
  saveExigenceConfirmation,
  uploadExigenceAnswerImage,
  exigenceInstances,
  exigenceAnswerDocId,
  loadProtocolTemplates,
  computeChecklistItems,
  loadIncidentDocs,
  ANOMALY_CATEGORIES,
  ANOMALY_URGENCY_LEVELS,
  loadBookingTimer,
  startBookingTimer,
  pauseBookingTimer,
  loadBookingComments,
  addBookingComment,
  buildClientPriceBreakdown,
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
const myComptaSummary = document.getElementById('myComptaSummary');
const myComptaList = document.getElementById('myComptaList');
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
let allMyBookings = [];
let selectedMissionId = null;
let activeBooking = null;
let activePhotoRecords = {};
// Liste normalisée issue de computeChecklistItems() : fusion de la
// bibliothèque partagée (protocolTemplates) et des ajouts propres à ce
// logement (exigences), pas seulement ces derniers malgré le nom conservé
// pour limiter le diff — buildExigenceRow/buildRoomAccordion/
// exigenceAnswerStats la consomment exactement comme avant.
let activeExigences = [];
let activeExigenceAnswers = {};
let activeExigencePhase = null;
let activeIncidents = [];
let protocolTemplatesCache = [];
let activeTimer = null;
let timerTickId = null;
let activeComments = [];
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

// Logement avec sa propre liste d'exigences ? Sinon activeExigences reste
// vide et renderActiveBooking garde l'ancien écran PHOTO_SLOTS plus bas.
async function loadExigencesForBooking(booking) {
  const [customExigences, answers, incidents] = await Promise.all([
    booking.propertyId ? loadExigencesForProperty(booking.propertyId) : Promise.resolve([]),
    loadExigenceAnswers(booking.id),
    loadIncidentDocs(booking.id),
  ]);
  activeExigenceAnswers = answers.reduce((acc, a) => ({ ...acc, [a.id]: a }), {});
  activeIncidents = incidents;
  // computeChecklistItems résout dependsOn contre les réponses déjà
  // données (ex. la question de relance du linge taché) : toujours
  // recalculé avec les dernières réponses, jamais mis en cache tel quel.
  activeExigences = computeChecklistItems(booking, protocolTemplatesCache, customExigences, activeExigenceAnswers);
  // Nouvelle mission : on repart de la première phase qui a des exigences.
  activeExigencePhase = (EXIGENCE_PHASES.find(p => activeExigences.some(e => e.phase === p.key)) || EXIGENCE_PHASES[0]).key;
}

async function loadTimerAndCommentsForBooking(booking) {
  activeTimer = await loadBookingTimer(booking.id);
  activeComments = await loadBookingComments(booking.id);
}

function countUploadedPhotos() {
  return PHOTO_SLOTS.filter(slot => activePhotoRecords[slot.key]).length;
}

function renderAssignedList() {
  assignedList.innerHTML = '';
  if (assignedBookings.length === 0) {
    assignedList.innerHTML = '<div class="empty-state">Aucune mission ne vous est assignée pour le moment. L’équipe Zebramoon vous attribue vos missions.</div>';
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
      await loadExigencesForBooking(booking);
      await loadTimerAndCommentsForBooking(booking);
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
    ratingSummary.innerHTML = '<div class="empty-state">Aucune évaluation pour le moment. Les clients notent la prestation une fois vérifiée par l’équipe Zebramoon.</div>';
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

// Compta du prestataire : ce que Zebramoon lui verse par mission (base fixée
// par l'équipe + bonus/malus). Le paiement effectif se fait hors application.
function renderMyCompta() {
  if (!myComptaSummary) return;
  myComptaSummary.innerHTML = '';
  myComptaList.innerHTML = '';
  const payout = b => (Number(b.prestatairePay) || 0) + (Number(b.adjustment) || 0);
  const total = allMyBookings.reduce((s, b) => s + payout(b), 0);

  const summary = document.createElement('div');
  summary.className = 'rating-avg';
  const num = document.createElement('span');
  num.className = 'rating-avg-num';
  num.textContent = `${total}€`;
  const sub = document.createElement('span');
  sub.className = 'rating-avg-out';
  sub.textContent = `sur ${allMyBookings.length} mission${allMyBookings.length > 1 ? 's' : ''}`;
  summary.appendChild(num);
  summary.appendChild(sub);
  myComptaSummary.appendChild(summary);
  const note = document.createElement('div');
  note.className = 'task-meta';
  note.textContent = 'Rémunération fixée par l’équipe Zebramoon. Le règlement se fait hors application.';
  myComptaSummary.appendChild(note);

  if (allMyBookings.length === 0) {
    myComptaList.innerHTML = '<div class="empty-state">Aucune mission pour le moment.</div>';
    return;
  }
  allMyBookings.forEach(booking => {
    const base = Number(booking.prestatairePay) || 0;
    const adj = Number(booking.adjustment) || 0;
    const item = document.createElement('div');
    item.className = 'task-card';
    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = booking.propertyAddress || booking.propertyId;
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    meta.textContent = `${formatShortDate(booking.scheduledDate)} · ${formatBookingStatus(booking.status)}`;
    item.appendChild(title);
    item.appendChild(meta);
    const payLine = document.createElement('div');
    payLine.className = 'task-meta roster-load';
    if (!base && !adj) {
      payLine.textContent = 'Rémunération à définir';
    } else {
      const adjPart = adj ? ` ${adj > 0 ? '+' : '−'}${Math.abs(adj)}€ (${adj > 0 ? 'bonus' : 'malus'})` : '';
      payLine.textContent = `${base}€${adjPart} = ${base + adj}€`;
    }
    item.appendChild(payLine);
    myComptaList.appendChild(item);
  });
}

// Une exigence compte 1 à N réponses attendues (confirmation, oui/non,
// une photo OU plusieurs photoSlots indépendants), et se répète une fois
// par pièce pour les exigences roomScope bedroom/bathroom/wc.
function exigenceAnswerStats(exigence, instance) {
  const answer = activeExigenceAnswers[exigenceAnswerDocId(activeBooking.id, exigence.id, instance.roomIndex)];
  let required = 0;
  let done = 0;
  if (exigence.requiresConfirmation) { required += 1; if (answer && answer.confirmed) done += 1; }
  if (exigence.requiresYesNo) { required += 1; if (answer && answer.answerYesNo != null) done += 1; }
  if (exigence.photoSlots && exigence.photoSlots.length) {
    exigence.photoSlots.forEach((label, slotIndex) => {
      required += 1;
      const slotAnswer = activeExigenceAnswers[exigenceAnswerDocId(activeBooking.id, exigence.id, instance.roomIndex, slotIndex)];
      if (slotAnswer && slotAnswer.photoUrl) done += 1;
    });
  } else if (exigence.requiresPhoto) {
    required += 1;
    if (answer && answer.photoUrl) done += 1;
  }
  return { required, done, answer };
}

// Un signalement ouvert sur ce point précis (même tâche, même instance de
// pièce) fait passer le statut en rouge "Anomalie", quel que soit l'état
// des réponses — un point peut être entièrement répondu et quand même
// porter une anomalie en cours.
function exigenceHasOpenAnomaly(exigence, instance) {
  return activeIncidents.some(inc => inc.itemId === exigence.id && (inc.roomIndex ?? null) === (instance.roomIndex ?? null) && inc.status === 'open');
}

const EXIGENCE_STATUS_META = {
  todo: { cls: 'todo', label: 'À faire' },
  partial: { cls: 'partial', label: 'En cours' },
  done: { cls: 'verified', label: 'Terminé' },
  anomaly: { cls: 'anomaly', label: 'Anomalie signalée' },
};

function exigenceStatusState(exigence, instance) {
  if (exigenceHasOpenAnomaly(exigence, instance)) return 'anomaly';
  const stats = exigenceAnswerStats(exigence, instance);
  if (stats.required === 0 || stats.done >= stats.required) return 'done';
  if (stats.done === 0) return 'todo';
  return 'partial';
}

function totalRequiredExigenceAnswers(items = activeExigences) {
  let total = 0;
  items.forEach(exigence => {
    exigenceInstances(exigence, activeBooking).forEach(instance => {
      total += exigenceAnswerStats(exigence, instance).required;
    });
  });
  return total;
}

function countAnsweredExigences(items = activeExigences) {
  let count = 0;
  items.forEach(exigence => {
    exigenceInstances(exigence, activeBooking).forEach(instance => {
      count += exigenceAnswerStats(exigence, instance).done;
    });
  });
  return count;
}

function renderExigenceChecklist(canAnswer) {
  const wrap = document.createElement('div');

  const progress = document.createElement('div');
  progress.className = 'exigence-progress';
  progress.textContent = `${countAnsweredExigences()} sur ${totalRequiredExigenceAnswers()} exigences`;
  wrap.appendChild(progress);

  const phasesWithItems = EXIGENCE_PHASES.filter(phase => activeExigences.some(e => e.phase === phase.key));
  if (!phasesWithItems.some(p => p.key === activeExigencePhase)) {
    activeExigencePhase = phasesWithItems.length ? phasesWithItems[0].key : null;
  }

  if (phasesWithItems.length > 1) {
    const tabbar = document.createElement('div');
    tabbar.className = 'exigence-tabbar';
    phasesWithItems.forEach(phase => {
      const items = activeExigences.filter(e => e.phase === phase.key);
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab' + (phase.key === activeExigencePhase ? ' active' : '');
      tab.textContent = phase.label;
      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      badge.textContent = `${countAnsweredExigences(items)}/${totalRequiredExigenceAnswers(items)}`;
      tab.appendChild(badge);
      tab.onclick = () => { activeExigencePhase = phase.key; renderActiveBooking(); };
      tabbar.appendChild(tab);
    });
    wrap.appendChild(tabbar);
  } else if (phasesWithItems.length === 1) {
    // Une seule phase rédigée pour ce logement : pas d'onglet à cliquer
    // (rien à basculer), mais on affiche quand même son nom.
    const phaseHead = document.createElement('div');
    phaseHead.className = 'roster-subhead';
    phaseHead.textContent = phasesWithItems[0].label;
    wrap.appendChild(phaseHead);
  }

  const activeItems = activeExigences.filter(e => e.phase === activeExigencePhase);
  const flatItems = activeItems.filter(e => e.roomScope === 'none' || e.roomScope === 'other');
  const roomItems = activeItems.filter(e => e.roomScope === 'bedroom' || e.roomScope === 'bathroom' || e.roomScope === 'wc');

  flatItems.forEach(exigence => {
    exigenceInstances(exigence, activeBooking).forEach(instance => {
      wrap.appendChild(buildExigenceRow(exigence, instance, canAnswer));
    });
  });

  // Une pièce peut porter plusieurs exigences (ex. "vérifier les draps" ET
  // "dépoussiérer", toutes deux par chambre) : regroupées sous un même
  // accordéon par pièce plutôt que répétées en liste plate, pour rester
  // lisible sur un logement avec beaucoup d'exigences.
  const roomGroups = new Map();
  roomItems.forEach(exigence => {
    exigenceInstances(exigence, activeBooking).forEach(instance => {
      const key = `${exigence.roomScope}_${instance.roomIndex}`;
      if (!roomGroups.has(key)) roomGroups.set(key, { label: instance.label, entries: [] });
      roomGroups.get(key).entries.push({ exigence, instance });
    });
  });
  roomGroups.forEach(group => wrap.appendChild(buildRoomAccordion(group, canAnswer)));

  return wrap;
}

function buildRoomAccordion(group, canAnswer) {
  const total = group.entries.reduce((sum, { exigence, instance }) => sum + exigenceAnswerStats(exigence, instance).required, 0);
  const done = group.entries.reduce((sum, { exigence, instance }) => sum + exigenceAnswerStats(exigence, instance).done, 0);

  const details = document.createElement('details');
  details.className = 'card exigence-room';
  if (done === total) details.open = false; else details.open = true;

  const summary = document.createElement('summary');
  const title = document.createElement('div');
  title.className = 'dossier-addr';
  title.textContent = group.label;
  const pill = document.createElement('span');
  pill.className = 'status-pill ' + (done === total ? 'verified' : 'rejected');
  pill.textContent = `${done}/${total}`;
  summary.append(title, pill);
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'collapse-body';
  group.entries.forEach(({ exigence, instance }) => {
    const row = buildExigenceRow(exigence, instance, canAnswer);
    row.querySelector('.dossier-addr').textContent = exigence.text; // la pièce est déjà dans le titre de l'accordéon
    body.appendChild(row);
  });
  details.appendChild(body);

  return details;
}

function buildPhotoSlotControl(exigence, instance, canAnswer, slotIndex, slotLabel) {
  const answerId = exigenceAnswerDocId(activeBooking.id, exigence.id, instance.roomIndex, slotIndex);
  const answer = activeExigenceAnswers[answerId];
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:inline-block;vertical-align:top;margin-right:10px;';
  if (slotLabel) {
    const cap = document.createElement('div');
    cap.className = 'task-meta';
    cap.textContent = slotLabel;
    wrap.appendChild(cap);
  }
  const slotEl = document.createElement('div');
  slotEl.className = 'photo-slot' + (answer && answer.photoUrl ? ' uploaded' : '');
  if (answer && answer.photoUrl) {
    const img = document.createElement('img');
    img.src = answer.photoUrl;
    img.alt = slotLabel || 'Photo';
    slotEl.appendChild(img);
  } else {
    const span = document.createElement('span');
    span.textContent = 'Photo';
    slotEl.appendChild(span);
  }
  if (canAnswer) {
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
          const saved = await withTimeout(uploadExigenceAnswerImage({
            bookingId: activeBooking.id,
            exigenceId: exigence.id,
            propertyId: activeBooking.propertyId,
            roomIndex: instance.roomIndex,
            slotIndex,
            file,
            answeredBy: currentUser.uid,
          }), 30000);
          activeExigenceAnswers[answerId] = { ...activeExigenceAnswers[answerId], ...saved };
          renderActiveBooking();
        } catch (e) {
          slotEl.classList.remove('uploading');
          setWorkStatus(`Photo non envoyée : ${storageErrorMessage(e)}`);
        }
      };
      fileInput.click();
    };
  }
  wrap.appendChild(slotEl);
  return wrap;
}

function buildAnomalyReport(exigence, instance) {
  const details = document.createElement('details');
  details.className = 'exigence-anomaly';
  const summary = document.createElement('summary');
  summary.textContent = 'Signaler un problème';
  details.appendChild(summary);

  const form = document.createElement('form');
  form.className = 'anomaly-form';

  const catLabel = document.createElement('label');
  catLabel.className = 'form-row';
  const catSel = document.createElement('select');
  ANOMALY_CATEGORIES.forEach(cat => {
    const o = document.createElement('option'); o.value = cat.key; o.textContent = cat.label;
    catSel.appendChild(o);
  });
  catLabel.append(catSel);
  form.append(catLabel);

  const urgLabel = document.createElement('label');
  urgLabel.className = 'form-row';
  const urgSel = document.createElement('select');
  ANOMALY_URGENCY_LEVELS.forEach(level => {
    const o = document.createElement('option'); o.value = level.key; o.textContent = `Urgence : ${level.label}`;
    urgSel.appendChild(o);
  });
  urgLabel.append(urgSel);
  form.append(urgLabel);

  const descArea = document.createElement('textarea');
  descArea.placeholder = 'Décrire le problème…';
  descArea.required = true;
  form.append(descArea);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  form.append(fileInput);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn ghost';
  submit.textContent = 'Envoyer le signalement';
  form.append(submit);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const description = descArea.value.trim();
    if (!description) return;
    try {
      await withButtonLoading(submit, async () => {
        const photoRefs = [];
        const files = Array.from(fileInput.files || []);
        for (const file of files) {
          const path = `incidents/${activeBooking.id}/${Date.now()}_${file.name}`;
          const storageRef = ref(storage, path);
          await withTimeout(uploadBytes(storageRef, file, { contentType: file.type || 'image/jpeg' }), 30000);
          photoRefs.push(await withTimeout(getDownloadURL(storageRef), 15000));
        }
        await withTimeout(addDoc(collection(db, 'incidents'), {
          bookingId: activeBooking.id,
          reportedBy: currentUser.uid,
          type: catSel.value,
          urgency: urgSel.value,
          description,
          itemId: exigence.id,
          roomIndex: instance.roomIndex ?? null,
          phase: exigence.phase,
          photoRefs,
          reportedAt: serverTimestamp(),
          status: 'open',
        }), 15000);
        activeIncidents = await loadIncidentDocs(activeBooking.id);
        queueEmail({
          to: TEAM_EMAIL,
          subject: `Zebramoon, anomalie signalée · Réf ${activeBooking.id.slice(0, 6).toUpperCase()}`,
          text: `${exigence.text} · ${description} · signalé par ${currentUser.name || currentUser.email}.`,
        });
        renderActiveBooking();
      });
    } catch (e) {
      setWorkStatus(`Signalement non envoyé : ${storageErrorMessage(e)}`);
    }
  });

  details.appendChild(form);
  return details;
}

function buildExigenceRow(exigence, instance, canAnswer) {
  const answerId = exigenceAnswerDocId(activeBooking.id, exigence.id, instance.roomIndex);
  const answer = activeExigenceAnswers[answerId];
  const label = instance.label ? `${exigence.text} — ${instance.label}` : exigence.text;

  const row = document.createElement('div');
  row.className = 'dossier exigence-row';

  const title = document.createElement('div');
  title.className = 'dossier-addr';
  title.textContent = label;
  row.appendChild(title);

  if (exigence.referencePhotoUrl) {
    const refImg = document.createElement('img');
    refImg.className = 'exigence-reference';
    refImg.src = exigence.referencePhotoUrl;
    refImg.alt = 'Référence';
    row.appendChild(refImg);
  }

  const state = exigenceStatusState(exigence, instance);
  const meta = EXIGENCE_STATUS_META[state];
  const pill = document.createElement('span');
  pill.className = 'status-pill ' + meta.cls;
  pill.textContent = meta.label;
  row.appendChild(pill);

  if (exigence.requiresConfirmation) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ' + (answer && answer.confirmed ? 'primary' : 'ghost');
    btn.textContent = answer && answer.confirmed ? 'Fait ✓' : 'Marquer comme fait';
    btn.disabled = !canAnswer;
    btn.onclick = async () => {
      setWorkStatus('');
      try {
        const saved = await withTimeout(saveExigenceConfirmation({
          bookingId: activeBooking.id,
          exigenceId: exigence.id,
          propertyId: activeBooking.propertyId,
          roomIndex: instance.roomIndex,
          answeredBy: currentUser.uid,
        }), 15000);
        activeExigenceAnswers[answerId] = { ...activeExigenceAnswers[answerId], ...saved };
        renderActiveBooking();
      } catch (e) {
        setWorkStatus(`Confirmation non enregistrée : ${storageErrorMessage(e)}`);
      }
    };
    row.appendChild(btn);
  }

  if (exigence.requiresYesNo) {
    const toggle = document.createElement('div');
    toggle.className = 'exigence-yesno';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn ' + (answer && answer.answerYesNo === true ? 'primary' : 'ghost');
    yes.textContent = 'Oui';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn ' + (answer && answer.answerYesNo === false ? 'primary' : 'ghost');
    no.textContent = 'Non';
    const answerYesNo = async value => {
      setWorkStatus('');
      try {
        const saved = await withTimeout(saveExigenceYesNo({
          bookingId: activeBooking.id,
          exigenceId: exigence.id,
          propertyId: activeBooking.propertyId,
          roomIndex: instance.roomIndex,
          answeredBy: currentUser.uid,
          answerYesNo: value,
        }), 15000);
        activeExigenceAnswers[answerId] = { ...activeExigenceAnswers[answerId], ...saved };
        renderActiveBooking();
      } catch (e) {
        setWorkStatus(`Réponse non enregistrée : ${storageErrorMessage(e)}`);
      }
    };
    if (canAnswer) {
      yes.onclick = () => answerYesNo(true);
      no.onclick = () => answerYesNo(false);
    } else {
      yes.disabled = true;
      no.disabled = true;
    }
    toggle.append(yes, no);
    row.appendChild(toggle);
  }

  if (exigence.photoSlots && exigence.photoSlots.length) {
    const slotsWrap = document.createElement('div');
    slotsWrap.style.marginTop = '8px';
    exigence.photoSlots.forEach((slotLabel, slotIndex) => {
      slotsWrap.appendChild(buildPhotoSlotControl(exigence, instance, canAnswer, slotIndex, slotLabel));
    });
    row.appendChild(slotsWrap);
  } else if (exigence.requiresPhoto) {
    row.appendChild(buildPhotoSlotControl(exigence, instance, canAnswer, null, null));
  }

  row.appendChild(buildAnomalyReport(exigence, instance));

  return row;
}

// Même action côté Firestore pour les deux parcours (PHOTO_SLOTS ou
// exigences) : seul ce qui déclenche l'activation du bouton diffère.
function buildSubmitButton(label, disabled) {
  const button = document.createElement('button');
  button.className = 'btn gold';
  button.type = 'button';
  button.textContent = activeBooking.status === 'submitted'
    ? 'Dossier envoyé, en attente de vérification Zebramoon'
    : label;
  button.disabled = disabled;
  button.onclick = async () => {
    try {
      await withButtonLoading(button, () =>
        withTimeout(updateDoc(doc(db, 'bookings', activeBooking.id), { status: 'submitted' }), 15000));
      queueEmail({
        to: TEAM_EMAIL,
        subject: `Zebramoon, dossier photos à vérifier · Réf ${activeBooking.id.slice(0, 6).toUpperCase()}`,
        text: `${activeBooking.propertyAddress || activeBooking.propertyId} · ${formatShortDate(activeBooking.scheduledDate)} · soumis par ${currentUser.name || currentUser.email}. À contrôler dans /admin/.`,
      });
    } catch (e) {
      setWorkStatus(`Impossible d’envoyer le dossier : ${storageErrorMessage(e)}`);
    }
  };
  return button;
}

function formatElapsed(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
}

function currentTimerElapsedSeconds() {
  if (!activeTimer) return 0;
  const base = activeTimer.totalElapsedSeconds || 0;
  if (activeTimer.status === 'running' && activeTimer.startedAt) {
    return base + (Date.now() - activeTimer.startedAt) / 1000;
  }
  return base;
}

// Chrono de mission : repère personnel pour le prestataire pendant qu'il
// travaille, pas une preuve horodatée (voir firestore.rules). L'intervalle
// qui fait tiquer l'affichage est nettoyé à chaque re-rendu (début de
// renderActiveBooking) pour ne jamais en empiler plusieurs.
function renderTimerBlock(canUpload) {
  const wrap = document.createElement('div');
  wrap.className = 'exigence-timer';

  const display = document.createElement('span');
  display.className = 'exigence-timer-elapsed';
  display.textContent = formatElapsed(currentTimerElapsedSeconds());
  wrap.appendChild(display);

  const running = canUpload && activeTimer && activeTimer.status === 'running';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn ghost';
  btn.textContent = running ? 'Mettre en pause' : (activeTimer ? 'Reprendre le chrono' : 'Démarrer le chrono');
  btn.disabled = !canUpload;
  btn.onclick = async () => {
    try {
      if (running) {
        activeTimer = await withTimeout(pauseBookingTimer({
          bookingId: activeBooking.id,
          prestataireId: currentUser.uid,
          startedAt: activeTimer.startedAt,
          totalElapsedSeconds: activeTimer.totalElapsedSeconds,
        }), 15000);
      } else {
        activeTimer = await withTimeout(startBookingTimer({
          bookingId: activeBooking.id,
          prestataireId: currentUser.uid,
          resumeFrom: activeTimer ? activeTimer.totalElapsedSeconds : 0,
        }), 15000);
      }
      renderActiveBooking();
    } catch (e) {
      setWorkStatus(`Chronomètre non enregistré : ${storageErrorMessage(e)}`);
    }
  };
  wrap.appendChild(btn);

  if (running) {
    timerTickId = setInterval(() => {
      display.textContent = formatElapsed(currentTimerElapsedSeconds());
    }, 1000);
  }

  return wrap;
}

function buildCostsTile() {
  const details = document.createElement('details');
  details.className = 'card';
  const summary = document.createElement('summary');
  const title = document.createElement('h2');
  title.textContent = 'Coûts';
  summary.appendChild(title);
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'collapse-body';
  body.appendChild(buildClientPriceBreakdown(activeBooking));
  details.appendChild(body);
  return details;
}

// Pas de nouveau mécanisme d'envoi : la galerie reprend simplement les
// photos déjà déposées via le checklist d'exigences.
function buildAttachmentsTile() {
  const photos = Object.values(activeExigenceAnswers).filter(a => a.photoUrl);
  const details = document.createElement('details');
  details.className = 'card';
  const summary = document.createElement('summary');
  const title = document.createElement('h2');
  title.textContent = `Pièces jointes (${photos.length})`;
  summary.appendChild(title);
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'collapse-body';
  if (photos.length) {
    const grid = document.createElement('div');
    grid.className = 'attachment-grid';
    photos.forEach(a => {
      const img = document.createElement('img');
      img.src = a.photoUrl;
      img.alt = 'Photo de mission';
      grid.appendChild(img);
    });
    body.appendChild(grid);
  } else {
    const empty = document.createElement('p');
    empty.textContent = 'Aucune photo déposée pour le moment.';
    body.appendChild(empty);
  }
  details.appendChild(body);
  return details;
}

function buildCommentsTile(canUpload) {
  const details = document.createElement('details');
  details.className = 'card';
  details.open = true;
  const summary = document.createElement('summary');
  const title = document.createElement('h2');
  title.textContent = `Commentaires (${activeComments.length})`;
  summary.appendChild(title);
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'collapse-body';

  if (activeComments.length) {
    activeComments.forEach(c => {
      const item = document.createElement('div');
      item.className = 'comment-item';
      const meta = document.createElement('div');
      meta.className = 'comment-meta';
      meta.textContent = currentUser && c.authorId === currentUser.uid ? 'Vous' : 'Zebramoon';
      const text = document.createElement('div');
      text.className = 'comment-text';
      text.textContent = c.text;
      item.append(meta, text);
      body.appendChild(item);
    });
  } else {
    const empty = document.createElement('p');
    empty.textContent = 'Aucun commentaire pour le moment.';
    body.appendChild(empty);
  }

  if (canUpload) {
    const form = document.createElement('form');
    form.className = 'comment-form';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Ajouter un commentaire sur cette mission…';
    textarea.required = true;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn ghost';
    submit.textContent = 'Envoyer';
    form.append(textarea, submit);
    form.onsubmit = async event => {
      event.preventDefault();
      const text = textarea.value.trim();
      if (!text) return;
      try {
        await withButtonLoading(submit, () => withTimeout(addBookingComment({
          bookingId: activeBooking.id,
          authorId: currentUser.uid,
          text,
        }), 15000));
        activeComments = await loadBookingComments(activeBooking.id);
        renderActiveBooking();
      } catch (e) {
        setWorkStatus(`Commentaire non envoyé : ${storageErrorMessage(e)}`);
      }
    };
    body.appendChild(form);
  }

  details.appendChild(body);
  return details;
}

function renderActiveBooking() {
  if (timerTickId) { clearInterval(timerTickId); timerTickId = null; }
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

  if (activeBooking.keyAccess) {
    const keyBox = document.createElement('div');
    keyBox.className = 'key-access';
    const kh = document.createElement('div'); kh.className = 'key-access-head'; kh.textContent = '🔑 Accès & clés';
    const kt = document.createElement('div'); kt.className = 'key-access-body'; kt.textContent = activeBooking.keyAccess;
    keyBox.append(kh, kt);
    activeBookingContainer.appendChild(keyBox);
  }

  if (activeBooking.status === 'rejected' && activeBooking.adminNote) {
    const note = document.createElement('div');
    note.className = 'status-banner';
    note.textContent = `Dossier renvoyé par Zebramoon : ${activeBooking.adminNote}`;
    activeBookingContainer.appendChild(note);
  }

  const canUpload = ['accepted', 'rejected'].includes(activeBooking.status);

  activeBookingContainer.appendChild(renderTimerBlock(canUpload));

  if (activeExigences.length) {
    activeBookingContainer.appendChild(renderExigenceChecklist(canUpload));
    const total = totalRequiredExigenceAnswers();
    const answered = countAnsweredExigences();
    activeBookingContainer.appendChild(buildSubmitButton(`Envoyer pour vérification (${answered}/${total})`, !canUpload || answered < total));
  } else {
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
    activeBookingContainer.appendChild(buildSubmitButton(`Envoyer pour vérification (${count}/${PHOTO_SLOTS.length})`, !canUpload || count < PHOTO_SLOTS.length));
  }

  activeBookingContainer.appendChild(buildCostsTile());
  activeBookingContainer.appendChild(buildAttachmentsTile());
  activeBookingContainer.appendChild(buildCommentsTile(canUpload));

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
          subject: `Zebramoon, mission déclinée · Réf ${declinedId.slice(0, 6).toUpperCase()}`,
          text: `${declinedRef} · déclinée par ${currentUser.name || currentUser.email}. À réattribuer dans /admin/.`,
        });
        setWorkStatus('Mission déclinée. L’équipe Zebramoon la réattribuera.', 'success');
      } catch (e) {
        console.error('Décliner mission, échec:', e);
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
    allMyBookings = mine
      .filter(booking => booking.status !== 'cancelled')
      .sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate));
    const stillThere = assignedBookings.find(b => b.id === selectedMissionId);
    activeBooking = stillThere || assignedBookings[0] || null;
    selectedMissionId = activeBooking ? activeBooking.id : null;
    if (activeBooking) {
      await loadPhotosForBooking(activeBooking.id);
      await loadExigencesForBooking(activeBooking);
      await loadTimerAndCommentsForBooking(activeBooking);
    } else {
      activePhotoRecords = {};
      activeExigences = [];
      activeExigenceAnswers = {};
      activeIncidents = [];
      activeTimer = null;
      activeComments = [];
    }
    renderAssignedList();
    renderActiveBooking();
    renderRatings();
    renderMyCompta();
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
      authNotice = { message: 'Votre demande d’accès est en cours de vérification par l’équipe Zebramoon. Vous pourrez vous connecter dès qu’elle sera approuvée.', type: 'info' };
      await signOut(auth);
      return;
    }
    if (accountStatus === 'suspended') {
      authNotice = { message: 'Votre accès a été suspendu par l’équipe Zebramoon. Contactez-nous pour en savoir plus.', type: '' };
      await signOut(auth);
      return;
    }
    if (accountStatus !== 'approved') {
      authNotice = { message: 'Votre demande d’accès a été refusée. Contactez l’équipe Zebramoon si vous pensez qu’il s’agit d’une erreur.', type: '' };
      await signOut(auth);
      return;
    }
    currentUser = { uid: user.uid, ...docData };
    showApp();
    // Bibliothèque partagée, chargée une fois par session (pas par mission) :
    // un changement admin en cours de session n'apparaît qu'à la prochaine
    // connexion, compromis raisonnable pour un contenu qui change rarement.
    protocolTemplatesCache = await loadProtocolTemplates().catch(() => []);
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
    queueEmail({
      to: TEAM_EMAIL,
      subject: `Zebramoon, incident signalé · Réf ${activeBooking.id.slice(0, 6).toUpperCase()}`,
      text: `${activeBooking.propertyAddress || activeBooking.propertyId} · ${formatShortDate(activeBooking.scheduledDate)} · ${type}, « ${description} » signalé par ${currentUser.name || currentUser.email}.${file ? ' (photo jointe)' : ''} À traiter dans /admin/.`,
    });
    incidentForm.reset();
    setIncidentMessage('Signalement envoyé à l’équipe Zebramoon.', 'success');
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
    setAuthMessage('Demande envoyée. L’équipe Zebramoon va la vérifier, vous pourrez vous connecter dès qu’elle sera approuvée.', 'success');
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
