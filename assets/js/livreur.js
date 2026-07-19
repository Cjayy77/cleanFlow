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
} from './shared.js';
import {
  collection,
  query,
  where,
  onSnapshot,
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
const signOutBtn = document.getElementById('signOutBtn');
const userNameLabel = document.getElementById('userNameLabel');
const taskList = document.getElementById('taskList');

let currentUser = null;
let taskUnsub = null;

function setAuthMessage(message) {
  authError.textContent = message;
  authError.classList.toggle('hidden', !message);
}

function showAuth(message = '') {
  loadingScreen.classList.add('hidden');
  signOutBtn.classList.add('hidden');
  authScreen.classList.remove('hidden');
  appScreen.classList.add('hidden');
  setAuthMessage(message);
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
    taskList.innerHTML = '<div class="empty-state">Aucune tournée de linge pour le moment.</div>';
    return;
  }
  bookings.forEach(booking => {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.innerHTML = `
      <div class="task-top">
        <div>
          <div class="task-title"></div>
          <div class="task-meta">${formatShortDate(booking.scheduledDate)} · dépôt du linge propre + récupération du linge sale</div>
        </div>
        <div class="status-pill ${booking.status}">${formatBookingStatus(booking.status)}</div>
      </div>
      <div class="task-meta">Réf ${booking.id.slice(0, 6).toUpperCase()}</div>
    `;
    card.querySelector('.task-title').textContent = booking.propertyAddress || booking.propertyId;
    // TODO: confirm with team — le livreur doit-il pouvoir marquer une tournée "faite" ?
    taskList.appendChild(card);
  });
}

function loadLaundryTasks() {
  if (taskUnsub) taskUnsub();
  // Filtre unique + tri côté client : aucun index composite à créer.
  const taskQuery = query(collection(db, 'bookings'), where('linenRequested', '==', true));
  taskUnsub = onSnapshot(taskQuery, snapshot => {
    const bookings = snapshot.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .filter(booking => ['pending', 'accepted', 'submitted', 'verified'].includes(booking.status))
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
    renderTasks(bookings);
  }, () => setAuthMessage('Impossible de charger les tournées de linge.'));
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    if (taskUnsub) taskUnsub();
    showAuth();
    return;
  }
  try {
    const docData = await loadUserDoc(user.uid);
    if (!docData || docData.role !== ROLE_LIVREUR) {
      await signOut(auth);
      showAuth('Ce compte n’est pas autorisé sur l’interface livreur.');
      return;
    }
    currentUser = { uid: user.uid, ...docData };
    showApp();
    loadLaundryTasks();
  } catch (error) {
    await signOut(auth);
    showAuth(authErrorMessage(error));
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
