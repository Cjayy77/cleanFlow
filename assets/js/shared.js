// CleanFlow — couche de données Firebase partagée par les quatre interfaces.
// Firestore = données, Firebase Auth = connexion, Firebase Storage = photos.
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
import { firebaseConfig } from '../../firebase-config.js';

export const ROLE_CLIENT = 'client';
export const ROLE_PRESTATAIRE = 'prestataire';
export const ROLE_LIVREUR = 'livreur';
export const ROLE_ADMIN = 'admin';

// Tarification HORAIRE (cahier des charges William). Le prix de la prestation =
// tarif horaire × durée estimée. La durée dépend de la surface et du nombre de
// lits. Toute cette configuration est regroupée ici (source unique de vérité) et
// structurée pour être, à terme, pilotée depuis le back-office sans développeur.
// Valeurs par défaut (barème initial de William). Servent de secours si aucune
// configuration n'a été enregistrée depuis le back-office.
export const DEFAULT_PRICING = {
  // Tarifs horaires (€ HT / h).
  hourlyRates: { normal: 30, deep: 50 },
  // Durée de base par tranche de surface (colonne « 1 lit » de la grille).
  timeGrid: [
    { max: 25, baseHours: 1 },
    { max: 45, baseHours: 2 },
    { max: 65, baseHours: 3 },
    { max: 90, baseHours: 4 },
  ],
  hoursPerExtraBed: 0.5,      // +0,5 h par lit au-delà du premier
  hoursPerExtraBathroom: 0.5, // +0,5 h par salle de bain au-delà de la première
  hoursPer25sqmAbove90: 1,    // au-delà de 90 m² : +1 h par tranche de 25 m²
  maxAutoSurface: 250,        // au-delà : devis sur-mesure (pas de prix automatique)
  kitPrice: 20,               // kit de bienvenue (linge, consommables) — 1 / chambre
  travelFee: 10,              // frais de déplacement (forfait provisoire)
  commission: 8,              // commission CleanFlow appliquée (€ HT / intervention)
  commissionMin: 4,           // borne basse indicative (€ HT)
  commissionMax: 12,          // borne haute indicative (€ HT)
  subscriptionMonthly: 10,    // abonnement application (€ HT / mois / logement)
  vatRate: 0.20,              // taux de TVA
  taxCreditRate: 0.5,         // crédit d'impôt Services à la Personne (50 %)
  taxCreditEnabled: true,     // proposer le crédit d'impôt dans le devis
  // Texte libre du bas de devis (éditable back-office).
  devisText: "Devis émis par CleanFlow. Prix en euros. Le ménage est réalisé par un prestataire vérifié ; chaque intervention fait l'objet d'un contrôle photo par l'équipe CleanFlow avant confirmation. Devis valable 30 jours.",
  // Villes desservies (éditable back-office).
  cities: [],
};

// Champs numériques attendus dans la config (hors hourlyRates/timeGrid/textes).
export const PRICING_SCALARS = [
  'hoursPerExtraBed', 'hoursPerExtraBathroom', 'hoursPer25sqmAbove90', 'maxAutoSurface',
  'kitPrice', 'travelFee', 'commission', 'commissionMin', 'commissionMax', 'subscriptionMonthly', 'vatRate', 'taxCreditRate',
];

function toNum(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

// Nettoie/complète une config venue de Firestore : tout champ manquant ou
// invalide retombe sur la valeur par défaut. Impossible de casser le calcul.
export function normalizePricing(cfg) {
  cfg = cfg || {};
  const d = DEFAULT_PRICING;
  const hr = cfg.hourlyRates || {};
  let grid = Array.isArray(cfg.timeGrid)
    ? cfg.timeGrid
        .map(b => ({ max: toNum(b && b.max, 0), baseHours: toNum(b && b.baseHours, 0) }))
        .filter(b => b.max > 0 && b.baseHours > 0)
        .sort((a, b) => a.max - b.max)
    : [];
  if (!grid.length) grid = d.timeGrid.map(b => ({ ...b }));
  const out = {
    hourlyRates: { normal: toNum(hr.normal, d.hourlyRates.normal), deep: toNum(hr.deep, d.hourlyRates.deep) },
    timeGrid: grid,
    devisText: typeof cfg.devisText === 'string' && cfg.devisText.trim() ? cfg.devisText : d.devisText,
    cities: Array.isArray(cfg.cities) ? cfg.cities.map(c => String(c)).filter(Boolean) : [],
    taxCreditEnabled: cfg.taxCreditEnabled !== false,
  };
  PRICING_SCALARS.forEach(k => { out[k] = toNum(cfg[k], d[k]); });
  return out;
}

// Configuration active. Par défaut = DEFAULT_PRICING ; remplacée au chargement
// par la config du back-office via setPricing().
let activePricing = normalizePricing(DEFAULT_PRICING);
export function getPricing() { return activePricing; }
export function setPricing(cfg) { activePricing = normalizePricing(cfg); return activePricing; }

// Alias rétro-compatibles (valeurs par défaut, usage historique).
export const KIT_PRICE = DEFAULT_PRICING.kitPrice;
export const TRAVEL_FEE = DEFAULT_PRICING.travelFee;

// Amenities (consommables d'accueil), DISTINCTS des kits. Tarification à définir
// par William : provisoirement 0 €. Le champ existe déjà côté réservation et
// dans la compta admin pour que l'ajout ultérieur ne demande aucune migration.
export const AMENITIES_PRICE = 0;

// Zones = classification / assignation (et, plus tard, frais de déplacement).
// N'influencent PAS le prix de la prestation. Liste provisoire, ajustable.
export const ZONES = [
  { value: 'paris', label: 'Paris (intra-muros)' },
  { value: 'petite_couronne', label: 'Petite couronne (92 · 93 · 94)' },
  { value: 'grande_couronne', label: 'Grande couronne (77 · 78 · 91 · 95)' },
];

export function zoneLabel(value) {
  return (ZONES.find(z => z.value === value) || {}).label || value || '';
}

export function travelFeeForZone(/* zone */) {
  // Provisoire : forfait unique quelle que soit la zone.
  return getPricing().travelFee;
}

// Durée estimée d'un ménage (h) selon surface, nombre de lits et salles de bain.
// Renvoie null si surface invalide, { custom:true } au-delà de la limite auto.
export function estimateCleaningHours(surface, beds, bathrooms) {
  const P = getPricing();
  const s = Number(surface);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (s > P.maxAutoSurface) return { custom: true };
  const bedsEff = Math.max(1, Math.floor(Number(beds) || 1));
  const bathEff = Math.max(1, Math.floor(Number(bathrooms) || 1));
  const lastBand = P.timeGrid[P.timeGrid.length - 1];
  const band = P.timeGrid.find(b => s <= b.max);
  const base = band
    ? band.baseHours
    // Au-delà de la dernière tranche : +1 (paramétrable) par tranche de 25 m².
    : lastBand.baseHours + Math.ceil((s - lastBand.max) / 25) * P.hoursPer25sqmAbove90;
  const hours = base
    + (bedsEff - 1) * P.hoursPerExtraBed
    + (bathEff - 1) * P.hoursPerExtraBathroom;
  return { custom: false, hours, beds: bedsEff, bathrooms: bathEff };
}

// Détail de prix d'une réservation (modèle horaire). Renvoie null si surface
// invalide, ou { custom:true } si elle relève du devis sur-mesure.
export function computeBookingPrice({ surface, serviceType, beds, bathrooms, bedrooms, kitCount = 0, zone, amenitiesPrice = AMENITIES_PRICE }) {
  const est = estimateCleaningHours(surface, beds, bathrooms);
  if (!est) return null;
  if (est.custom) return { custom: true };
  const P = getPricing();
  const service = serviceType === 'deep' ? 'deep' : 'normal';
  const hourlyRate = P.hourlyRates[service];
  const prestation = Math.round(hourlyRate * est.hours);
  // 1 kit de bienvenue par chambre : le nombre de chambres pilote le nombre de kits.
  const rooms = bedrooms != null ? bedrooms : kitCount;
  const kits = Math.max(0, Math.floor(Number(rooms) || 0));
  const kitsTotal = kits * P.kitPrice;
  const amenitiesTotal = Math.max(0, Number(amenitiesPrice) || 0);
  const travel = travelFeeForZone(zone);
  const commission = Math.max(0, Number(P.commission) || 0); // commission CleanFlow / intervention
  // Les tarifs sont HT ; la TVA est un pass-through (n'entre pas dans la marge).
  const total = prestation + kitsTotal + amenitiesTotal + travel + commission; // total HT
  const vatRate = P.vatRate;
  const vat = Math.round(total * vatRate);
  return {
    custom: false,
    serviceType: service,
    beds: est.beds,
    bathrooms: est.bathrooms,
    hours: est.hours,
    hourlyRate,
    prestation,
    bedrooms: kits,
    kitCount: kits,
    kitsTotal,
    amenitiesTotal,
    travel,
    commission,
    subscriptionMonthly: Math.max(0, Number(P.subscriptionMonthly) || 0),
    total,
    vatRate,
    vat,
    totalTTC: total + vat,
  };
}

// TVA / TTC à partir d'un total HT et du taux courant (pour l'affichage admin).
export function vatBreakdown(totalHT) {
  const rate = getPricing().vatRate;
  const vat = Math.round((Number(totalHT) || 0) * rate);
  return { rate, vat, ttc: (Number(totalHT) || 0) + vat };
}

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Lignes HT d'une réservation, reconstruites depuis les champs stockés.
function bookingLineItems(b) {
  const price = Number(b.price) || 0;
  const prestation = Number(b.prestationPrice) || 0;
  const amenities = Number(b.amenitiesPrice) || 0;
  const travel = Number(b.travelFee) || 0;
  const commission = Number(b.commission) || 0;
  const extrasHT = Number(b.extrasHT) || 0;
  const kits = Math.max(0, price - prestation - amenities - extrasHT - travel - commission);
  const rooms = Number(b.bedrooms != null ? b.bedrooms : b.kitCount) || 0;
  const rate = b.hours ? Math.round(prestation / b.hours) : (b.serviceType === 'deep' ? 50 : 30);
  const items = [
    { label: `Ménage ${b.serviceType === 'deep' ? 'approfondi' : 'standard'}${b.hours ? ` · ${String(b.hours).replace('.', ',')} h × ${rate}€/h` : ''}`, amount: prestation },
  ];
  if (kits) items.push({ label: `Kits de bienvenue${rooms ? ` · ${rooms} chambre${rooms > 1 ? 's' : ''}` : ''}`, amount: kits });
  if (amenities) items.push({ label: 'Amenities (consommables)', amount: amenities });
  (b.extras || []).forEach(e => items.push({ label: `${e.name || 'Supplément'}${e.qty > 1 ? ` × ${e.qty}` : ''}`, amount: (Number(e.priceHT) || 0) * (Number(e.qty) || 0) }));
  if (commission) items.push({ label: 'Commission CleanFlow', amount: commission });
  if (travel) items.push({ label: 'Frais de déplacement', amount: travel });
  return { items, totalHT: price };
}

// Ouvre un devis / reçu imprimable (→ « Enregistrer au format PDF » du navigateur).
// Entièrement côté client : aucun backend requis.
export function openDevisDocument(booking, client) {
  const P = getPricing();
  const { items, totalHT } = bookingLineItems(booking);
  const rate = P.vatRate;
  const vat = Math.round(totalHT * rate);
  const ttc = totalHT + vat;
  const devisText = escapeHtml(P.devisText || '');
  const subscription = Math.max(0, Number(P.subscriptionMonthly) || 0);
  const ref = `CF-${String(booking.id || '').slice(0, 6).toUpperCase()}`;
  const today = new Date();
  const fmt = d => d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const validUntil = new Date(today); validUntil.setDate(today.getDate() + 30);
  const clientName = escapeHtml((client && client.name) || '');
  const clientEmail = escapeHtml((client && client.email) || booking.clientEmail || '');
  const rows = items.map(it => `<tr><td>${escapeHtml(it.label)}</td><td class="amt">${it.amount}&nbsp;€</td></tr>`).join('');
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Devis ${ref} — CleanFlow</title>
<style>
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{ font-family:'Helvetica Neue',Arial,sans-serif; color:#12123A; padding:40px 46px; font-size:14px; }
  .top{ display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:34px; }
  .brand{ display:flex; align-items:center; gap:12px; font-size:24px; font-weight:800; }
  .brand .k{ color:#E6007E; }
  .doc-meta{ text-align:right; font-size:13px; color:#555; }
  .doc-meta h1{ font-size:22px; letter-spacing:2px; color:#12123A; margin-bottom:6px; }
  .parties{ display:flex; justify-content:space-between; gap:30px; margin-bottom:26px; }
  .parties h3{ font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#E6007E; margin-bottom:6px; }
  .parties div{ font-size:13px; line-height:1.5; color:#333; }
  table{ width:100%; border-collapse:collapse; margin-bottom:20px; }
  th{ text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#888; border-bottom:2px solid #12123A; padding:8px 0; }
  th.amt, td.amt{ text-align:right; white-space:nowrap; }
  td{ padding:11px 0; border-bottom:1px solid #ECEAF3; }
  .totals{ margin-left:auto; width:280px; }
  .totals .row{ display:flex; justify-content:space-between; padding:7px 0; font-size:14px; }
  .totals .ttc{ border-top:2px solid #12123A; margin-top:4px; padding-top:12px; font-size:18px; font-weight:800; color:#E6007E; }
  .foot{ margin-top:38px; font-size:11px; color:#888; line-height:1.6; border-top:1px solid #ECEAF3; padding-top:16px; }
  svg{ width:34px; height:34px; }
  @media print{ body{ padding:24px; } .noprint{ display:none; } }
  .noprint{ margin-top:26px; }
  .noprint button{ background:#E6007E; color:#fff; border:none; border-radius:8px; padding:11px 20px; font-size:14px; font-weight:700; cursor:pointer; }
</style></head><body>
  <div class="top">
    <div class="brand">
      <svg viewBox="0 0 400 400"><g fill="#E6007E"><path d="M56 332 Q116.4 194.7 127.42 41.45 A22 22 0 1 1 169.02 54.97 Q137.2 201.5 56 332 Z" opacity=".55"/><path d="M56 332 Q144.9 218.0 193.63 77.81 A23 23 0 1 1 232.29 102.88 Q164.3 230.5 56 332 Z" opacity=".7"/><path d="M56 332 Q166.5 243.3 250.25 124.83 A24 24 0 1 1 282.26 160.40 Q182.5 261.1 56 332 Z" opacity=".82"/><path d="M56 332 Q192.7 272.8 318.04 188.07 A25 25 0 1 1 338.31 233.58 Q202.9 295.6 56 332 Z" opacity=".92"/><path d="M56 332 Q208.3 309.3 358.36 268.77 A26 26 0 1 1 364.68 320.21 Q211.4 335.0 56 332 Z"/></g></svg>
      <span><span class="k">Clean</span>Flow</span>
    </div>
    <div class="doc-meta">
      <h1>DEVIS</h1>
      <div>N° ${ref}</div>
      <div>Date : ${fmt(today)}</div>
      <div>Validité : ${fmt(validUntil)}</div>
    </div>
  </div>
  <div class="parties">
    <div>
      <h3>Client</h3>
      <div>${clientName || '—'}<br>${clientEmail}</div>
    </div>
    <div style="text-align:right">
      <h3>Logement</h3>
      <div>${escapeHtml(booking.propertyAddress || '')}<br>${booking.surface ? `${booking.surface} m²` : ''} · Intervention le ${escapeHtml(formatShortDate(booking.scheduledDate))}</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Prestation</th><th class="amt">Montant HT</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div class="row"><span>Total HT</span><b>${totalHT}&nbsp;€</b></div>
    <div class="row"><span>TVA (${Math.round(rate * 100)} %)</span><b>${vat}&nbsp;€</b></div>
    <div class="row ttc"><span>Total TTC</span><span>${ttc}&nbsp;€</span></div>
  </div>
  ${subscription ? `<div style="margin-top:10px;font-size:11px;color:#888;text-align:right;">+ Abonnement application : ${subscription}&nbsp;€ HT / mois / logement (facturé séparément)</div>` : ''}
  <div class="foot">
    ${devisText} Conditions générales disponibles sur le site.
  </div>
  <div class="noprint"><button onclick="window.print()">Imprimer / enregistrer en PDF</button></div>
  <script>window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 300); });<\/script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  return true;
}

// Boîte de réception de l'équipe pour les notifications internes.
// Doit rester identique à l'adresse autorisée dans firestore.rules (/mail).
export const TEAM_EMAIL = 'w.wanecque@gmail.com';

// TODO: confirm with team — liste exacte des photos exigées par mission.
export const PHOTO_SLOTS = [
  { key: 'kitchen_before', label: 'Cuisine — avant' },
  { key: 'kitchen_after', label: 'Cuisine — après' },
  { key: 'bathroom', label: 'Salle de bain' },
  { key: 'bedroom1', label: 'Chambre 1' },
  { key: 'bedroom2', label: 'Chambre 2' },
  { key: 'linen', label: 'Linge changé' },
];

const configMissing = Object.values(firebaseConfig).some(value => String(value).startsWith('REPLACE'));
if (configMissing) {
  const renderNotice = () => {
    document.body.innerHTML = `
      <div style="max-width:560px;margin:80px auto;padding:36px;font-family:sans-serif;border:1px solid #DCE1EE;border-radius:8px;background:#fff;color:#10131A;">
        <div style="font-family:monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#002FA7;margin-bottom:12px;">CleanFlow — configuration requise</div>
        <h1 style="font-size:20px;margin:0 0 12px;">Firebase n'est pas encore configuré</h1>
        <p style="line-height:1.6;color:#5A6472;">Copiez la configuration web de votre projet Firebase dans <code>firebase-config.js</code>, puis rechargez la page. Les étapes complètes sont dans <code>SETUP.md</code>.</p>
      </div>`;
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNotice);
  } else {
    renderNotice();
  }
  throw new Error('Firebase non configuré — voir SETUP.md');
}

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
// Sans ces limites, le SDK réessaie ~2 min avant d'abandonner (ex. bucket
// Storage non activé) : l'échec est ramené à ~12 s avec un vrai code d'erreur.
storage.maxUploadRetryTime = 12000;
storage.maxOperationRetryTime = 12000;

export async function loadUserDoc(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

// Seuls les clients peuvent créer un compte eux-mêmes ; les comptes
// prestataire/livreur/admin sont créés manuellement (voir SETUP.md) et les
// règles Firestore refusent tout autre rôle à l'auto-inscription.
export async function registerClient({ name, email, password, phone }) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await withTimeout(setDoc(doc(db, 'users', credential.user.uid), {
    uid: credential.user.uid,
    role: ROLE_CLIENT,
    name,
    email,
    phone,
    accountStatus: 'approved',
    createdAt: serverTimestamp(),
  }), 15000);
  return credential.user;
}

export async function loadPhotoDocs(bookingId) {
  const snap = await getDocs(query(collection(db, 'photos'), where('bookingId', '==', bookingId)));
  return snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function loadIncidentDocs(bookingId) {
  const snap = await getDocs(query(collection(db, 'incidents'), where('bookingId', '==', bookingId)));
  return snap.docs
    .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
    .sort((a, b) => (b.reportedAt?.toMillis?.() || 0) - (a.reportedAt?.toMillis?.() || 0));
}

// Une photo par emplacement : re-téléverser le même emplacement remplace la
// précédente (utile quand l'admin rejette le dossier).
export async function uploadBookingImage({ bookingId, slot, file, uploadedBy }) {
  const normalizedSlot = slot.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const storagePath = `bookings/${bookingId}/${normalizedSlot}`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, file, { contentType: file.type || 'image/jpeg' });
  const downloadUrl = await getDownloadURL(storageRef);
  const photoDoc = {
    bookingId,
    slot: normalizedSlot,
    uploadedBy,
    storagePath,
    downloadUrl,
    uploadedAt: serverTimestamp(),
    verified: false,
  };
  await setDoc(doc(db, 'photos', `${bookingId}_${normalizedSlot}`), photoDoc);
  return photoDoc;
}

// Upload d'une image d'article de catalogue (admin) → renvoie l'URL publique.
export async function uploadCatalogImage(file) {
  const safe = (file.name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_');
  const storageRef = ref(storage, `catalog/${Date.now()}-${safe}`);
  await uploadBytes(storageRef, file, { contentType: file.type || 'image/jpeg' });
  return getDownloadURL(storageRef);
}

export function formatShortDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatBookingStatus(status) {
  switch (status) {
    case 'pending': return 'En attente';
    case 'accepted': return 'Accepté';
    case 'submitted': return 'Photos soumises';
    case 'verified': return 'Confirmé';
    case 'rejected': return 'À corriger';
    case 'cancelled': return 'Annulée';
    default: return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

// Demande d'accès prestataire/livreur/admin : crée le compte en statut
// "pending", invisible et sans droits tant qu'un admin ne l'a pas approuvé
// dans /admin/. Passe par une seconde instance Firebase pour ne pas toucher
// à la session en cours sur la page.
export async function requestTeamAccess({ role, name, email, password, phone, inviteCode }) {
  const secondary = initializeApp(firebaseConfig, `access-request-${Date.now()}`);
  const secondaryAuth = getAuth(secondary);
  const secondaryDb = getFirestore(secondary);
  try {
    const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await withTimeout(setDoc(doc(secondaryDb, 'users', credential.user.uid), {
      uid: credential.user.uid,
      role,
      name,
      email,
      phone,
      inviteCode: inviteCode || '',
      accountStatus: 'pending',
      createdAt: serverTimestamp(),
    }), 15000);
    await withTimeout(addDoc(collection(secondaryDb, 'mail'), {
      to: TEAM_EMAIL,
      message: {
        subject: `CleanFlow — nouvelle demande d’accès ${role}`,
        text: `${name} (${email}, ${phone}) demande un accès ${role}.${inviteCode ? ` Code d’invitation saisi : ${inviteCode}.` : ' Aucun code d’invitation saisi.'} À traiter dans /admin/.`,
      },
      createdAt: serverTimestamp(),
    }), 10000).catch(() => {});
    return credential.user.uid;
  } finally {
    await signOut(secondaryAuth).catch(() => {});
    await deleteApp(secondary).catch(() => {});
  }
}

// E-mail de réinitialisation du mot de passe (flux natif Firebase).
export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

// File d'envoi d'e-mails : dépose un document dans la collection `mail`,
// que l'extension Firebase « Trigger Email » transforme en vrai e-mail
// (voir SETUP.md). Sans l'extension, les documents s'accumulent sans effet —
// l'action métier n'échoue jamais à cause d'un e-mail.
export function queueEmail({ to, subject, text }) {
  return addDoc(collection(db, 'mail'), {
    to,
    message: { subject, text },
    createdAt: serverTimestamp(),
  }).catch(() => {});
}

// Confirmation « deux clics » directement sur un bouton, sans window.confirm
// (celui-ci reste muet si l'utilisateur a bloqué les dialogues du site). Le
// premier clic arme le bouton (libellé rouge, 5 s) ; le second exécute l'action.
// `guard` (optionnel) est évalué au premier clic : s'il renvoie false, on n'arme
// pas (il peut afficher son propre message).
export function armInlineConfirm(button, confirmLabel, onConfirm, guard) {
  const idleLabel = button.textContent;
  let armed = false;
  let timer = null;
  const disarm = () => {
    armed = false;
    button.textContent = idleLabel;
    button.classList.remove('confirm');
    if (timer) { clearTimeout(timer); timer = null; }
  };
  button.addEventListener('click', () => {
    if (!armed) {
      if (guard && !guard()) return;
      armed = true;
      button.textContent = confirmLabel;
      button.classList.add('confirm');
      timer = setTimeout(disarm, 5000);
      return;
    }
    disarm();
    onConfirm();
  });
}

// État visuel de chargement d'un bouton pendant une action asynchrone.
export async function withButtonLoading(button, task) {
  if (button) button.classList.add('loading');
  try {
    return await task();
  } finally {
    if (button) button.classList.remove('loading');
  }
}

// Coupe une promesse qui ne répond pas (ex. upload vers un bucket Storage
// inexistant : le SDK réessaie longtemps au lieu d'échouer franchement).
export function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => {
      const err = new Error('timeout');
      err.code = 'app/timeout';
      reject(err);
    }, ms)),
  ]);
}

export function storageErrorMessage(error) {
  switch (error?.code) {
    case 'storage/unauthorized':
      return 'Envoi refusé par les règles de sécurité. Vérifiez que les règles Storage sont publiées dans la console Firebase.';
    case 'storage/retry-limit-exceeded':
    case 'app/timeout':
      return 'Le stockage de photos ne répond pas. Il n’est probablement pas activé sur le projet Firebase (Storage, plan Blaze). Voir SETUP.md, étape 1.';
    case 'storage/quota-exceeded':
      return 'Quota de stockage dépassé.';
    case 'storage/canceled':
      return 'Envoi annulé.';
    default:
      return authErrorMessage(error);
  }
}

export function authErrorMessage(error) {
  switch (error?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email ou mot de passe incorrect.';
    case 'auth/email-already-in-use':
      return 'Un compte existe déjà avec cette adresse.';
    case 'auth/weak-password':
      return 'Mot de passe trop court (6 caractères minimum).';
    case 'auth/invalid-email':
      return 'Adresse email invalide.';
    case 'auth/too-many-requests':
      return 'Trop de tentatives. Réessayez dans quelques minutes.';
    case 'auth/network-request-failed':
    case 'unavailable':
      return 'Problème de connexion. Vérifiez votre réseau et réessayez.';
    case 'app/timeout':
      return 'La base de données ne répond pas. Vérifiez votre connexion et réessayez.';
    case 'permission-denied':
      return 'Accès refusé par la base de données. Les règles Firestore ne sont probablement pas publiées (voir SETUP.md, étape 3).';
    default:
      return error?.message || 'Une erreur est survenue.';
  }
}
