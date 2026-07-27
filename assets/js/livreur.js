// Kleining — interface livreur : tournées de linge liées aux réservations.
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
} from './shared.js';
import {
  collection,
  query,
  where,
  onSnapshot,
  updateDoc,
  doc,
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

function renderTasks(bookings) {
  taskList.innerHTML = '';
  if (bookings.length === 0) {
    taskList.innerHTML = '<div class="empty-state">Aucune tournée ne vous est assignée pour le moment. L’équipe Kleining vous attribue vos tournées.</div>';
    return;
  }
  bookings.forEach(booking => {
    const card = document.createElement('div');
    card.className = 'task-card' + (booking.linenDone ? ' done' : '');
    card.innerHTML = `
      <div class="task-top">
        <div>
          <div class="task-title"></div>
          <div class="task-meta">${formatShortDate(booking.scheduledDate)} · dépôt du linge propre + récupération du linge sale</div>
        </div>
        <div class="status-pill ${booking.linenDone ? 'verified' : booking.status}">${booking.linenDone ? 'Linge géré' : formatBookingStatus(booking.status)}</div>
      </div>
      <div class="task-meta">Réf ${booking.id.slice(0, 6).toUpperCase()}</div>
    `;
    card.querySelector('.task-title').textContent = booking.propertyAddress || booking.propertyId;
    const toggleBtn = document.createElement('button');
    toggleBtn.className = booking.linenDone ? 'btn ghost' : 'btn primary';
    toggleBtn.type = 'button';
    toggleBtn.textContent = booking.linenDone ? 'Annuler (tournée non faite)' : 'Marquer la tournée faite';
    toggleBtn.onclick = async () => {
      try {
        await withButtonLoading(toggleBtn, () =>
          withTimeout(updateDoc(doc(db, 'bookings', booking.id), { linenDone: !booking.linenDone }), 15000));
      } catch (e) {
        setWorkStatus(`Impossible de mettre à jour la tournée : ${authErrorMessage(e)}`);
      }
    };
    card.appendChild(toggleBtn);
    taskList.appendChild(card);
  });
}

function loadLaundryTasks() {
  if (taskUnsub) taskUnsub();
  // Le livreur ne voit que les tournées que l'équipe Kleining lui a assignées.
  // Filtre unique + tri côté client : aucun index composite à créer.
  const taskQuery = query(collection(db, 'bookings'), where('livreurId', '==', currentUser.uid));
  taskUnsub = onSnapshot(taskQuery, snapshot => {
    const bookings = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .filter(booking => ['pending', 'accepted', 'submitted', 'verified'].includes(booking.status))
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
      authNotice = { message: 'Votre demande d’accès est en cours de vérification par l’équipe Kleining. Vous pourrez vous connecter dès qu’elle sera approuvée.', type: 'info' };
      await signOut(auth);
      return;
    }
    if (accountStatus === 'suspended') {
      authNotice = { message: 'Votre accès a été suspendu par l’équipe Kleining. Contactez-nous pour en savoir plus.', type: '' };
      await signOut(auth);
      return;
    }
    if (accountStatus !== 'approved') {
      authNotice = { message: 'Votre demande d’accès a été refusée. Contactez l’équipe Kleining si vous pensez qu’il s’agit d’une erreur.', type: '' };
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
  try {
    await withButtonLoading(requestForm.querySelector('button[type="submit"]'), () =>
      requestTeamAccess({ role: ROLE_LIVREUR, name, email, password, phone, inviteCode }));
    requestForm.reset();
    requestForm.classList.add('hidden');
    signInForm.classList.remove('hidden');
    setAuthMessage('Demande envoyée. L’équipe Kleining va la vérifier — vous pourrez vous connecter dès qu’elle sera approuvée.', 'success');
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
