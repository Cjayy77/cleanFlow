import { auth, db, ROLE_LIVREUR, loadUserDoc, formatBookingStatus } from './shared.js';
import { collection, query, where, orderBy, onSnapshot } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

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

function showAuth() {
  authScreen.style.display = 'block';
  appScreen.style.display = 'none';
  setAuthMessage('');
}

function showApp() {
  authScreen.style.display = 'none';
  appScreen.style.display = 'block';
  setAuthMessage('');
  userNameLabel.textContent = currentUser.name || currentUser.email;
}

function renderTasks(bookings) {
  taskList.innerHTML = '';
  if (bookings.length === 0) {
    taskList.innerHTML = '<div class="empty-state">Aucune tâche de linge pour le moment.</div>';
    return;
  }
  bookings.forEach(booking => {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.innerHTML = `
      <div class="task-top">
        <div>
          <div class="task-title">${booking.propertyAddress || booking.propertyId}</div>
          <div class="task-meta">${booking.scheduledDate} · ${booking.serviceType === 'deep' ? 'Nettoyage en profondeur' : 'Nettoyage normal'}</div>
        </div>
        <div class="status-pill ${booking.status}">${formatBookingStatus(booking.status)}</div>
      </div>
      <div class="task-meta">${booking.price}€ · Réf ${booking.id.slice(0, 6).toUpperCase()}</div>
    `;
    taskList.appendChild(card);
  });
}

async function loadLaundryTasks() {
  if (taskUnsub) taskUnsub();
  const taskQuery = query(collection(db, 'bookings'), where('linenRequested', '==', true), where('status', 'in', ['pending', 'accepted', 'submitted', 'verified']), orderBy('scheduledDate', 'asc'));
  taskUnsub = onSnapshot(taskQuery, snapshot => {
    const bookings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderTasks(bookings);
  }, error => {
    setAuthMessage('Impossible de charger les tâches linges.');
  });
}

async function ensureLivreurRole(user) {
  const docData = await loadUserDoc(user.uid);
  if (!docData || docData.role !== ROLE_LIVREUR) {
    throw new Error('Ce compte n’est pas autorisé sur l’interface livreur.');
  }
  return docData;
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    showAuth();
    return;
  }
  try {
    const docData = await ensureLivreurRole(user);
    currentUser = { uid: user.uid, ...docData };
    showApp();
    await loadLaundryTasks();
  } catch (error) {
    setAuthMessage(error.message);
    await signOut(auth);
    showAuth();
  }
});

signInForm.addEventListener('submit', async event => {
  event.preventDefault();
  setAuthMessage('');
  const email = document.getElementById('signInEmail').value.trim();
  const password = document.getElementById('signInPassword').value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    setAuthMessage(err.message);
  }
});

signOutBtn.addEventListener('click', async () => {
  await signOut(auth);
  currentUser = null;
  if (taskUnsub) taskUnsub();
  showAuth();
});
