// Zebramoon, interface livreur : tournées de linge liées aux réservations.
import {
  auth,
  db,
  ROLE_LIVREUR,
  loadUserDoc,
  formatShortDate,
  formatBookingStatus,
  authErrorMessage,
  withButtonLoading,
  withTimeout,
  resetPassword,
  requestTeamAccess,
  segmentedControl,
  buildCalendarButtons,
  storageErrorMessage,
} from './shared.js';
import { uploadPhotoToR2, getPhotoDownloadUrl } from './r2-upload.js';
import {
  collection,
  query,
  where,
  onSnapshot,
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
const signInForm = document.getElementById('signInForm');
const requestForm = document.getElementById('requestForm');
const switchToRequest = document.getElementById('switchToRequest');
const switchToSignIn = document.getElementById('switchToSignIn');
const signOutBtn = document.getElementById('signOutBtn');
const userNameLabel = document.getElementById('userNameLabel');
const taskList = document.getElementById('taskList');
const workStatus = document.getElementById('workStatus');

function setWorkStatus(message, type = 'error') {
  workStatus.textContent = message;
  workStatus.className = `status-banner ${type}` + (message ? '' : ' hidden');
}

let currentUser = null;
let authNotice = null;
let taskUnsub = null;

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

let taskSeg = 'todo';
let lastBookings = [];

// Ce qu'il faut apporter : kits de bienvenue, puis chaque option « avec livreur ».
function deliveryLines(booking) {
  const lines = [];
  if (booking.kitCount) lines.push(`${booking.kitCount} kit${booking.kitCount > 1 ? 's' : ''} de bienvenue`);
  (booking.extras || []).forEach(e => {
    const delivered = typeof e.needsDelivery === 'boolean' ? e.needsDelivery : e.type !== 'service';
    if (delivered && e.type !== 'service') lines.push(`${e.name} × ${e.qty}`);
  });
  return lines;
}

function renderTasks(bookings) {
  lastBookings = bookings;
  taskList.innerHTML = '';
  const todo = bookings.filter(b => !b.linenDone);
  const done = bookings.filter(b => b.linenDone);
  const ctl = segmentedControl({
    items: [{ key: 'todo', label: 'À livrer', count: todo.length }, { key: 'done', label: 'Faites', count: done.length }],
    current: taskSeg,
    onChange: key => { taskSeg = key; renderTasks(lastBookings); },
  });
  taskList.appendChild(ctl.el);
  const shown = taskSeg === 'todo' ? todo : done;
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = taskSeg === 'todo'
      ? 'Aucune livraison à faire pour le moment. L’équipe Zebramoon vous attribue vos tournées.'
      : 'Aucune livraison terminée récemment.';
    taskList.appendChild(empty);
    return;
  }
  shown.forEach(booking => {
    const card = document.createElement('div');
    card.className = 'task-card' + (booking.linenDone ? ' done' : '');
    card.innerHTML = `
      <div class="task-top">
        <div>
          <div class="task-title"></div>
          <div class="task-meta">À livrer avant le ménage du ${formatShortDate(booking.scheduledDate)} · Réf ${booking.id.slice(0, 6).toUpperCase()}</div>
        </div>
        <div class="status-pill ${booking.linenDone ? 'verified' : 'pending'}">${booking.linenDone ? 'Livré' : 'À livrer'}</div>
      </div>
    `;
    card.querySelector('.task-title').textContent = booking.propertyAddress || booking.propertyId;
    const lines = deliveryLines(booking);
    const box = document.createElement('div');
    box.className = 'key-access';
    const head = document.createElement('div');
    head.className = 'key-access-head';
    head.textContent = 'À déposer dans le logement';
    box.appendChild(head);
    (lines.length ? lines : ['Linge propre']).concat(['Récupérer le linge sale du séjour précédent']).forEach(t => {
      const row = document.createElement('div');
      row.className = 'key-access-body';
      row.textContent = t;
      box.appendChild(row);
    });
    card.appendChild(box);
    if (!booking.linenDone) card.appendChild(buildCalendarButtons(booking, 'delivery'));
    if (booking.keyAccess) {
      const keyBox = document.createElement('div');
      keyBox.className = 'key-access';
      const kh = document.createElement('div'); kh.className = 'key-access-head'; kh.textContent = 'Accès et clés';
      const kt = document.createElement('div'); kt.className = 'key-access-body'; kt.textContent = booking.keyAccess;
      keyBox.append(kh, kt);
      card.appendChild(keyBox);
    }
    if (booking.linenDone) {
      const proof = document.createElement('div');
      proof.className = 'delivery-proof';
      const when = booking.deliveredAt && booking.deliveredAt.toDate ? booking.deliveredAt.toDate() : null;
      const cap = document.createElement('div');
      cap.className = 'task-meta';
      cap.textContent = when ? `Livré le ${when.toLocaleDateString('fr-FR')} à ${when.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : 'Livraison confirmée';
      proof.appendChild(cap);
      if (booking.deliveryPhotoKey) {
        const img = document.createElement('img');
        img.alt = 'Preuve de livraison';
        proof.appendChild(img);
        getPhotoDownloadUrl({ bookingId: booking.id, scope: 'deliveries', objectKey: booking.deliveryPhotoKey })
          .then(url => { img.src = url; }).catch(() => { img.remove(); });
      }
      card.appendChild(proof);
    }
    const toggleBtn = document.createElement('button');
    toggleBtn.className = booking.linenDone ? 'btn ghost' : 'btn primary';
    toggleBtn.type = 'button';
    toggleBtn.textContent = booking.linenDone ? 'Annuler (livraison non faite)' : 'Marquer comme livré (photo)';
    const send = async file => {
      try {
        await withButtonLoading(toggleBtn, async () => {
          const objectKey = await uploadPhotoToR2({
            bookingId: booking.id, scope: 'deliveries', file,
            onProgress: pct => { toggleBtn.textContent = `Envoi de la photo ${pct} %`; },
          });
          await withTimeout(updateDoc(doc(db, 'bookings', booking.id), {
            linenDone: true, deliveredAt: serverTimestamp(), deliveryPhotoKey: objectKey,
          }), 15000);
        });
        setWorkStatus('Livraison confirmée, photo enregistrée.', 'success');
      } catch (e) {
        toggleBtn.textContent = 'Réessayer l’envoi de la photo';
        toggleBtn.onclick = () => send(file);
        setWorkStatus(`Livraison non enregistrée : ${storageErrorMessage(e)}`);
      }
    };
    toggleBtn.onclick = async () => {
      if (booking.linenDone) {
        try {
          await withButtonLoading(toggleBtn, () =>
            withTimeout(updateDoc(doc(db, 'bookings', booking.id), { linenDone: false, deliveredAt: null, deliveryPhotoKey: null }), 15000));
          setWorkStatus('Livraison remise à faire.', 'success');
        } catch (e) {
          setWorkStatus(`Impossible de mettre à jour la livraison : ${authErrorMessage(e)}`);
        }
        return;
      }
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.setAttribute('capture', 'environment');
      input.onchange = () => { if (input.files[0]) send(input.files[0]); };
      input.click();
    };
    card.appendChild(toggleBtn);
    taskList.appendChild(card);
  });
}

function loadLaundryTasks() {
  if (taskUnsub) taskUnsub();
  // Le livreur ne voit que les tournées que l'équipe Zebramoon lui a assignées.
  // Filtre unique + tri côté client : aucun index composite à créer.
  const taskQuery = query(collection(db, 'bookings'), where('livreurId', '==', currentUser.uid));
  taskUnsub = onSnapshot(taskQuery, snapshot => {
    const bookings = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .filter(booking => ['pending', 'accepted', 'submitted', 'verified'].includes(booking.status))
      .filter(booking => !booking.linenDone || (booking.scheduledDate || '') >= new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10))
      .sort((a, b) => (!!a.linenDone - !!b.linenDone) || a.scheduledDate.localeCompare(b.scheduledDate));
    renderTasks(bookings);
  }, error => setWorkStatus(`Impossible de charger vos tournées de linge : ${authErrorMessage(error)}`));
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    if (taskUnsub) taskUnsub();
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
    if (!docData || docData.role !== ROLE_LIVREUR) {
      authNotice = { message: 'Ce compte n’est pas autorisé sur l’interface livreur.', type: '' };
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
    loadLaundryTasks();
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
  const contractAccepted = document.getElementById('requestContract').checked;
  try {
    if (!contractAccepted) throw new Error('Acceptez le contrat de prestation pour envoyer la demande.');
    await withButtonLoading(requestForm.querySelector('button[type="submit"]'), () =>
      requestTeamAccess({ role: ROLE_LIVREUR, name, email, password, phone, inviteCode, contractAccepted }));
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
