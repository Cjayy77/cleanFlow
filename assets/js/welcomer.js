// CleanFlow — interface Welcomer : contrôle qualité sur place (checklist,
// photos horodatées, signature) et validation envoyée au propriétaire.
import {
  auth,
  db,
  storage,
  ROLE_WELCOMER,
  loadUserDoc,
  formatShortDate,
  formatBookingStatus,
  authErrorMessage,
  withButtonLoading,
  withTimeout,
  resetPassword,
  requestTeamAccess,
  queueEmail,
  TEAM_EMAIL,
  welcomerTier,
} from './shared.js';
import { collection, query, where, onSnapshot, updateDoc, doc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

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
const taskList = document.getElementById('taskList');
const workStatus = document.getElementById('workStatus');

const CHECKLIST = [
  { key: 'menage', label: 'Ménage conforme' },
  { key: 'linge', label: 'Linge installé' },
  { key: 'consommables', label: 'Consommables vérifiés' },
  { key: 'equipements', label: 'Équipements vérifiés' },
  { key: 'ambiance', label: 'Volets ouverts / lumières / mise en place' },
];

let currentUser = null;
let authNotice = null;
let taskUnsub = null;

function setWorkStatus(message, type = 'error') {
  workStatus.textContent = message;
  workStatus.className = `status-banner ${type}` + (message ? '' : ' hidden');
}
function setAuthMessage(message, type = '') {
  authError.textContent = message;
  authError.className = 'status-banner' + (type ? ` ${type}` : '') + (message ? '' : ' hidden');
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

function renderTasks(bookings) {
  taskList.innerHTML = '';
  if (!bookings.length) {
    taskList.innerHTML = '<div class="empty-state">Aucune mission de contrôle assignée pour le moment.</div>';
    return;
  }
  bookings.forEach(booking => {
    const done = ['verified', 'rejected'].includes(booking.status) && booking.welcomerLevel;
    const card = document.createElement('div');
    card.className = 'task-card' + (done ? ' done' : '');
    const tier = welcomerTier(booking.welcomerService);
    const top = document.createElement('div');
    top.className = 'task-top';
    const left = document.createElement('div');
    const title = document.createElement('div'); title.className = 'task-title'; title.textContent = booking.propertyAddress || booking.propertyId;
    const meta = document.createElement('div'); meta.className = 'task-meta';
    meta.textContent = `${formatShortDate(booking.scheduledDate)} · ${tier ? tier.label : 'Validation'} · Réf ${booking.id.slice(0, 6).toUpperCase()}`;
    left.append(title, meta);
    const pill = document.createElement('div');
    pill.className = `status-pill ${booking.status}`;
    pill.textContent = done ? (booking.welcomerLevel === 1 ? 'Validé sur place' : 'Non conforme') : formatBookingStatus(booking.status);
    top.append(left, pill);
    card.appendChild(top);

    if (done) {
      const summary = document.createElement('div');
      summary.className = 'task-meta';
      summary.textContent = `Niveau ${booking.welcomerLevel}${booking.welcomerNote ? ' · ' + booking.welcomerNote : ''}`;
      card.appendChild(summary);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn primary'; btn.type = 'button'; btn.textContent = 'Contrôler sur place';
      btn.style.marginTop = '12px';
      btn.onclick = () => {
        if (card.querySelector('.wc-form')) { card.querySelector('.wc-form').remove(); return; }
        card.appendChild(buildValidationForm(booking));
      };
      card.appendChild(btn);
    }
    taskList.appendChild(card);
  });
}

function buildValidationForm(booking) {
  const form = document.createElement('div');
  form.className = 'wc-form';
  form.style.cssText = 'margin-top:14px;border-top:1px solid var(--line);padding-top:14px;';

  // Checklist
  const clWrap = document.createElement('div');
  const clHead = document.createElement('div'); clHead.className = 'eyebrow'; clHead.textContent = 'Checklist';
  clWrap.appendChild(clHead);
  const checks = {};
  CHECKLIST.forEach(item => {
    const row = document.createElement('label'); row.className = 'wc-check';
    const cb = document.createElement('input'); cb.type = 'checkbox';
    checks[item.key] = cb;
    const span = document.createElement('span'); span.textContent = item.label;
    row.append(cb, span); clWrap.appendChild(row);
  });
  form.appendChild(clWrap);

  // Photos horodatées
  const phHead = document.createElement('div'); phHead.className = 'eyebrow'; phHead.style.marginTop = '16px'; phHead.textContent = 'Photos';
  form.appendChild(phHead);
  const photoUrls = [];
  const preview = document.createElement('div'); preview.className = 'wc-photos';
  const fileIn = document.createElement('input'); fileIn.type = 'file'; fileIn.accept = 'image/*'; fileIn.multiple = true;
  fileIn.addEventListener('change', async () => {
    for (const file of Array.from(fileIn.files || [])) {
      try {
        const r = ref(storage, `welcomer/${booking.id}/${Date.now()}-${(file.name || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_')}`);
        await withTimeout(uploadBytes(r, file, { contentType: file.type || 'image/jpeg' }), 30000);
        const url = await withTimeout(getDownloadURL(r), 15000);
        photoUrls.push(url);
        const img = document.createElement('img'); img.src = url; preview.appendChild(img);
      } catch (e) { setWorkStatus(`Photo non envoyée : ${authErrorMessage(e)}`); }
    }
    fileIn.value = '';
  });
  form.append(fileIn, preview);

  // Signature
  const sgHead = document.createElement('div'); sgHead.className = 'eyebrow'; sgHead.style.marginTop = '16px'; sgHead.textContent = 'Signature';
  form.appendChild(sgHead);
  const canvas = document.createElement('canvas'); canvas.className = 'wc-sign'; canvas.width = 360; canvas.height = 140;
  const ctx = canvas.getContext('2d'); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#12123A';
  let drawing = false; let signed = false;
  const pos = e => { const r = canvas.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX - r.left) * (canvas.width / r.width), y: (t.clientY - r.top) * (canvas.height / r.height) }; };
  const start = e => { drawing = true; signed = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = e => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); };
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerdown', start); canvas.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  form.appendChild(canvas);
  const clearBtn = document.createElement('button'); clearBtn.type = 'button'; clearBtn.className = 'mini-btn'; clearBtn.textContent = 'Effacer la signature';
  clearBtn.onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); signed = false; };
  form.appendChild(clearBtn);

  // Niveau de conformité
  const lvHead = document.createElement('div'); lvHead.className = 'eyebrow'; lvHead.style.marginTop = '16px'; lvHead.textContent = 'Résultat';
  form.appendChild(lvHead);
  const lv = document.createElement('div'); lv.className = 'wc-level';
  [[1, 'Conforme — validé (petites corrections faites sur place)'], [2, 'À corriger — le prestataire doit repasser (reste en attente)'], [3, 'Non conforme — propriétaire averti, pénalité prestataire']].forEach(([v, l], i) => {
    const row = document.createElement('label');
    const r = document.createElement('input'); r.type = 'radio'; r.name = `lv-${booking.id}`; r.value = String(v); if (i === 0) r.checked = true;
    const s = document.createElement('span'); s.textContent = l;
    row.append(r, s); lv.appendChild(row);
  });
  form.appendChild(lv);

  const noteRow = document.createElement('div'); noteRow.className = 'form-row'; noteRow.style.marginTop = '12px';
  const noteLbl = document.createElement('label'); noteLbl.textContent = 'Note (anomalie, correction…)';
  const note = document.createElement('textarea');
  noteRow.append(noteLbl, note); form.appendChild(noteRow);

  const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'btn primary'; submit.textContent = 'Valider et envoyer au propriétaire';
  submit.onclick = async () => {
    const level = Number((form.querySelector(`input[name="lv-${booking.id}"]:checked`) || {}).value || 1);
    const checklist = {}; CHECKLIST.forEach(it => { checklist[it.key] = checks[it.key].checked; });
    if (level === 1 && !CHECKLIST.every(it => checks[it.key].checked)) {
      setWorkStatus('Pour valider (niveau 1), cochez toute la checklist ou choisissez un autre niveau.'); return;
    }
    const payload = {
      status: level === 1 ? 'verified' : 'rejected',
      welcomerLevel: level,
      welcomerChecklist: checklist,
      welcomerPhotos: photoUrls,
      welcomerSignature: signed ? canvas.toDataURL('image/png') : '',
      welcomerNote: note.value.trim(),
      validatedAt: serverTimestamp(),
    };
    try {
      await withButtonLoading(submit, () => withTimeout(updateDoc(doc(db, 'bookings', booking.id), payload), 20000));
      queueEmail({
        to: TEAM_EMAIL,
        subject: `CleanFlow — contrôle Welcomer niveau ${level} · ${booking.propertyAddress || ''}`,
        text: `Réf ${booking.id.slice(0, 6).toUpperCase()} · niveau ${level} · ${photoUrls.length} photo(s).${payload.welcomerNote ? ' Note : ' + payload.welcomerNote : ''}`,
      });
      setWorkStatus(level === 1 ? 'Logement validé — le propriétaire est notifié.' : 'Contrôle enregistré — mission renvoyée.', 'success');
    } catch (e) {
      setWorkStatus(`Validation impossible : ${authErrorMessage(e)}`);
    }
  };
  form.appendChild(submit);
  return form;
}

function loadMissions() {
  if (taskUnsub) taskUnsub();
  const q = query(collection(db, 'bookings'), where('welcomerId', '==', currentUser.uid));
  taskUnsub = onSnapshot(q, snapshot => {
    const bookings = snapshot.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(b => ['accepted', 'submitted', 'verified', 'rejected'].includes(b.status))
      .sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''));
    renderTasks(bookings);
  }, error => setWorkStatus(`Impossible de charger vos missions : ${authErrorMessage(error)}`));
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    if (taskUnsub) taskUnsub();
    if (authNotice) { showAuth(authNotice.message, authNotice.type); authNotice = null; } else { showAuth(); }
    return;
  }
  try {
    const docData = await loadUserDoc(user.uid);
    if (!docData || docData.role !== ROLE_WELCOMER) {
      authNotice = { message: 'Ce compte n’est pas autorisé sur l’interface Welcomer.', type: '' };
      await signOut(auth); return;
    }
    const accountStatus = docData.accountStatus ?? 'approved';
    if (accountStatus === 'pending') {
      authNotice = { message: 'Votre demande d’accès est en cours de vérification par l’équipe CleanFlow.', type: 'info' };
      await signOut(auth); return;
    }
    if (accountStatus === 'suspended') {
      authNotice = { message: 'Votre accès a été suspendu par l’équipe CleanFlow.', type: '' };
      await signOut(auth); return;
    }
    if (accountStatus !== 'approved') {
      authNotice = { message: 'Votre demande d’accès a été refusée.', type: '' };
      await signOut(auth); return;
    }
    currentUser = { uid: user.uid, ...docData };
    showApp();
    loadMissions();
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
    await withButtonLoading(signInForm.querySelector('button[type="submit"]'), () => signInWithEmailAndPassword(auth, email, password));
  } catch (err) { setAuthMessage(authErrorMessage(err)); }
});

signOutBtn.addEventListener('click', async () => { await signOut(auth); });

switchToRequest.addEventListener('click', event => { event.preventDefault(); signInForm.classList.add('hidden'); requestForm.classList.remove('hidden'); setAuthMessage(''); });
switchToSignIn.addEventListener('click', event => { event.preventDefault(); requestForm.classList.add('hidden'); signInForm.classList.remove('hidden'); setAuthMessage(''); });

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
      requestTeamAccess({ role: ROLE_WELCOMER, name, email, password, phone, inviteCode }));
    requestForm.reset();
    requestForm.classList.add('hidden');
    signInForm.classList.remove('hidden');
    setAuthMessage('Demande envoyée. L’équipe CleanFlow va la vérifier.', 'success');
  } catch (err) { setAuthMessage(authErrorMessage(err), 'error'); }
});

document.getElementById('forgotPassword').addEventListener('click', async event => {
  event.preventDefault();
  const email = document.getElementById('signInEmail').value.trim();
  if (!email) { setAuthMessage('Saisissez d’abord votre adresse email ci-dessus.', 'info'); return; }
  try {
    await resetPassword(email);
    setAuthMessage(`Email de réinitialisation envoyé à ${email}.`, 'success');
  } catch (err) { setAuthMessage(authErrorMessage(err), 'error'); }
});
