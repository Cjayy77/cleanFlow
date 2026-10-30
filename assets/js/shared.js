// Zebramoon, couche de données Firebase partagée par les quatre interfaces.
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
  deleteDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
import { firebaseConfig } from '../../firebase-config.js';
import qrcode from './vendor/qrcode.js';
import { uploadPhotoToR2 } from './r2-upload.js';

export const ROLE_CLIENT = 'client';
export const ROLE_PRESTATAIRE = 'prestataire';
export const ROLE_LIVREUR = 'livreur';
export const ROLE_WELCOMER = 'welcomer';
export const ROLE_ADMIN = 'admin';

// Formules Welcomer (contrôle qualité sur place). Facturables ; l'admin peut
// ajuster les tarifs plus tard via le back-office (mêmes valeurs par défaut).
export const WELCOMER_TIERS = [
  { key: 'validation', label: 'Validation du ménage', fee: 15 },
  { key: 'validation_photos', label: 'Validation + photos', fee: 20 },
  { key: 'validation_accueil', label: 'Validation + accueil voyageur', fee: 35 },
  { key: 'validation_edl', label: 'Validation + état des lieux', fee: 45 },
];
export function welcomerTier(key) {
  return WELCOMER_TIERS.find(t => t.key === key) || null;
}

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
  kitPrice: 20,               // kit de bienvenue (linge, consommables), 1 / chambre
  travelFee: 10,              // frais de déplacement (forfait provisoire)
  commission: 8,              // commission Zebramoon appliquée (€ HT / intervention)
  commissionMin: 4,           // borne basse indicative (€ HT)
  commissionMax: 12,          // borne haute indicative (€ HT)
  subscriptionMonthly: 10,    // abonnement application (€ HT / mois / logement)
  vatRate: 0.20,              // taux de TVA
  taxCreditRate: 0.5,         // crédit d'impôt Services à la Personne (50 %)
  taxCreditEnabled: true,     // proposer le crédit d'impôt dans le devis
  // Texte libre du bas de devis (éditable back-office).
  devisText: "Devis émis par Zebramoon. Prix en euros. Le ménage est réalisé par un prestataire vérifié ; chaque intervention fait l'objet d'un contrôle photo par l'équipe Zebramoon avant confirmation. Devis valable 30 jours.",
  // Villes desservies (éditable back-office).
  cities: [],
};

// Champs numériques attendus dans la config (hors hourlyRates/timeGrid/textes).
export const PRICING_SCALARS = [
  'hoursPerExtraBed', 'hoursPerExtraBathroom', 'hoursPer25sqmAbove90', 'maxAutoSurface',
  'kitPrice', 'travelFee', 'commission', 'commissionMin', 'commissionMax', 'subscriptionMonthly', 'vatRate', 'taxCreditRate',
];

// Sous-ensemble de la config publiable sans authentification (calculateur de
// la page d'accueil et du devis en ligne, cf. /settings/publicPricing dans
// firestore.rules). Volontairement SANS commission/commissionMin/commissionMax
// (marge Zebramoon), subscriptionMonthly (abonnement propriétaire) ni
// taxCreditRate/devisText/cities : rien qui renseigne un visiteur non
// authentifié sur la structure de marge ou l'activité de l'entreprise.
export const PUBLIC_PRICING_FIELDS = [
  'hourlyRates', 'timeGrid', 'hoursPerExtraBed', 'hoursPerExtraBathroom',
  'hoursPer25sqmAbove90', 'maxAutoSurface', 'kitPrice', 'travelFee', 'vatRate',
  'taxCreditEnabled', // simple interrupteur d'affichage, pas une donnée de marge
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

// Déduit la zone depuis le code postal, pour ne jamais demander au client de
// choisir lui-même un « secteur » (terminologie interne). Couverture bêta :
// Paris et proche banlieue ; code non reconnu → Paris par défaut.
export function zoneFromPostalCode(postalCode) {
  const prefix = String(postalCode || '').trim().slice(0, 2);
  if (['92', '93', '94'].includes(prefix)) return 'petite_couronne';
  if (['77', '78', '91', '95'].includes(prefix)) return 'grande_couronne';
  return 'paris';
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
  const commission = Math.max(0, Number(P.commission) || 0); // commission Zebramoon / intervention
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
  if (commission) items.push({ label: 'Commission Zebramoon', amount: commission });
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
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Devis ${ref}, Zebramoon</title>
<style>
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{ font-family:'Manrope','Helvetica Neue',Arial,sans-serif; color:#1A160F; padding:40px 46px; font-size:14px; }
  .top{ display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:34px; }
  .brand{ display:flex; align-items:center; gap:12px; font-size:24px; font-weight:800; }
  .brand .k{ color:#E6007E; }
  .doc-meta{ text-align:right; font-size:13px; color:#555; }
  .doc-meta h1{ font-size:22px; letter-spacing:2px; color:#1A160F; margin-bottom:6px; }
  .parties{ display:flex; justify-content:space-between; gap:30px; margin-bottom:26px; }
  .parties h3{ font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#E6007E; margin-bottom:6px; }
  .parties div{ font-size:13px; line-height:1.5; color:#333; }
  table{ width:100%; border-collapse:collapse; margin-bottom:20px; }
  th{ text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#888; border-bottom:2px solid #1A160F; padding:8px 0; }
  th.amt, td.amt{ text-align:right; white-space:nowrap; }
  td{ padding:11px 0; border-bottom:1px solid #E4DBC7; }
  .totals{ margin-left:auto; width:280px; }
  .totals .row{ display:flex; justify-content:space-between; padding:7px 0; font-size:14px; }
  .totals .ttc{ border-top:2px solid #1A160F; margin-top:4px; padding-top:12px; font-size:18px; font-weight:800; color:#E6007E; }
  .foot{ margin-top:38px; font-size:11px; color:#888; line-height:1.6; border-top:1px solid #E4DBC7; padding-top:16px; }
  svg{ width:34px; height:34px; }
  @media print{ body{ padding:24px; } .noprint{ display:none; } }
  .noprint{ margin-top:26px; }
  .noprint button{ background:#E6007E; color:#fff; border:none; border-radius:4px; padding:11px 20px; font-size:14px; font-weight:700; cursor:pointer; }
</style></head><body>
  <div class="top">
    <div class="brand">
      <svg viewBox="0 0 400 400"><g fill="#1A160F"><path d="M56 332 Q116.4 194.7 127.42 41.45 A22 22 0 1 1 169.02 54.97 Q137.2 201.5 56 332 Z"/><path d="M56 332 Q144.9 218.0 193.63 77.81 A23 23 0 1 1 232.29 102.88 Q164.3 230.5 56 332 Z" fill="#E6007E"/><path d="M56 332 Q166.5 243.3 250.25 124.83 A24 24 0 1 1 282.26 160.40 Q182.5 261.1 56 332 Z"/><path d="M56 332 Q192.7 272.8 318.04 188.07 A25 25 0 1 1 338.31 233.58 Q202.9 295.6 56 332 Z" fill="#E6007E"/><path d="M56 332 Q208.3 309.3 358.36 268.77 A26 26 0 1 1 364.68 320.21 Q211.4 335.0 56 332 Z"/></g></svg>
      <span><span class="k">Zebra</span>moon</span>
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
      <div>${clientName || ', '}<br>${clientEmail}</div>
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

// ---- QR code du logement (contrôle Welcomer) --------------------------------
// Un QR PERMANENT par logement : imprimé une fois, laissé dans l'appartement.
// Le Welcomer le scanne sur place ; l'app ouvre sa mission en cours sur ce
// logement. Le QR encode un lien profond vers /welcomer/?p=<propertyId>.
const QR_FALLBACK_ORIGIN = 'https://clean-flow-dun.vercel.app';

export function logementQrUrl(propertyId) {
  const origin = (typeof location !== 'undefined' && typeof location.origin === 'string' && location.origin.startsWith('http'))
    ? location.origin
    : QR_FALLBACK_ORIGIN;
  return `${origin}/welcomer/?p=${encodeURIComponent(propertyId)}`;
}

// Renvoie une balise <svg> QR autonome (aucune dépendance réseau à l'affichage).
export function qrSvg(text, { cellSize = 6, margin = 4 } = {}) {
  const q = qrcode(0, 'M'); // type auto, correction M
  q.addData(String(text));
  q.make();
  return q.createSvgTag({ cellSize, margin, scalable: false });
}

// Ouvre une fiche QR imprimable à afficher dans le logement (→ « Enregistrer en
// PDF » du navigateur). Entièrement côté client.
// Accepte un bien ({ id, street, city }) ou une réservation ({ propertyId,
// propertyAddress }) : le QR encode toujours le LOGEMENT (propertyId).
export function openLogementQr(target) {
  const propertyId = target.propertyId || target.id;
  if (!propertyId) return false;
  const url = logementQrUrl(propertyId);
  const ref6 = String(propertyId).slice(0, 6).toUpperCase();
  const svg = qrSvg(url, { cellSize: 9, margin: 4 });
  const addressText = target.propertyAddress
    || [target.street, target.city].filter(Boolean).join(', ')
    || 'Logement';
  const addr = escapeHtml(addressText);
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QR logement · ${escapeHtml(ref6)}</title>
  <style>
    @page { margin: 20mm; }
    body { font-family:'Manrope', system-ui, -apple-system, sans-serif; color:#1A160F; text-align:center; padding:32px 24px; }
    .brand { font-family:'Plus Jakarta Sans','Manrope',sans-serif; font-size:26px; font-weight:600; letter-spacing:-0.01em; }
    .brand span { color:#E6007E; }
    .sub { color:#6E6656; margin-top:4px; font-size:14px; }
    .qr { display:inline-block; margin:26px auto 14px; padding:18px; border:1px solid #E4DBC7; border-radius:4px; }
    .qr svg { width:280px; height:280px; display:block; }
    .ref { font-weight:700; font-size:18px; letter-spacing:0.04em; }
    .addr { color:#6E6656; margin-top:6px; font-size:14px; }
    .hint { max-width:340px; margin:22px auto 0; color:#1A160F; font-size:14px; line-height:1.5; }
    .noprint button { margin-top:24px; padding:10px 16px; border:0; border-radius:4px; background:#E6007E; color:#fff; font-weight:700; cursor:pointer; }
    @media print { .noprint { display:none; } }
  </style></head>
  <body>
    <div class="brand"><span>Zebra</span>moon</div>
    <div class="sub">Contrôle qualité, logement</div>
    <div class="qr">${svg}</div>
    <div class="ref">Réf ${escapeHtml(ref6)}</div>
    <div class="addr">${addr}</div>
    <p class="hint">À votre arrivée, scannez ce code avec l’appareil photo de votre téléphone (ou le bouton « Scanner le QR » de l’interface Welcomer) pour ouvrir directement le contrôle de ce logement.</p>
    <div class="noprint"><button onclick="window.print()">Imprimer / enregistrer en PDF</button></div>
    <script>window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 300); });<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  return true;
}

// ⇩⇩ ADRESSE DE L'ÉQUIPE, SOURCE UNIQUE POUR TOUT LE SITE ⇩⇩
// Utilisée par les 4 portails + le devis public (tous importent TEAM_EMAIL).
// Pour basculer sur la boîte OVH : changez CETTE ligne (une seule), puis
// alignez teamInbox() dans firestore.rules (+ republier les règles) et le
// FROM/SMTP de l'extension « Trigger Email ». Détails : SETUP.md.
export const TEAM_EMAIL = 'w.wanecque@gmail.com';

// Liste générique, utilisée uniquement pour les logements SANS exigences
// rédigées dans /exigences (voir plus bas). Dès qu'un logement a sa propre
// liste, le parcours prestataire bascule dessus et ignore PHOTO_SLOTS.
export const PHOTO_SLOTS = [
  { key: 'kitchen_before', label: 'Cuisine, avant' },
  { key: 'kitchen_after', label: 'Cuisine, après' },
  { key: 'bathroom', label: 'Salle de bain' },
  { key: 'bedroom1', label: 'Chambre 1' },
  { key: 'bedroom2', label: 'Chambre 2' },
  { key: 'linen', label: 'Linge changé' },
];

// Exigences par logement (rédigées par l'équipe dans /admin/) : chaque
// exigence appartient à une phase, et peut se répéter une fois par pièce
// (roomScope) au lieu d'être rédigée pièce par pièce. Le nombre de pièces
// vient des champs bedrooms/bathrooms déjà recopiés sur la réservation au
// moment de la réservation (pas une lecture live du logement, pour que la
// liste d'une mission en cours ne bouge pas si le logement est modifié).
export const EXIGENCE_PHASES = [
  { key: 'avant', label: 'Avant ménage' },
  { key: 'menage', label: 'Ménage' },
  { key: 'apres', label: 'Après ménage' },
];

export const EXIGENCE_ROOM_SCOPES = [
  { key: 'none', label: 'Exigence unique' },
  { key: 'bedroom', label: 'Une fois par chambre' },
  { key: 'bathroom', label: 'Une fois par salle de bain' },
  { key: 'wc', label: 'Une fois par WC' },
  { key: 'smoke_detector', label: 'Une fois par détecteur de fumée' },
  { key: 'key_box', label: 'Une fois par boîte à clés' },
  { key: 'other', label: 'Zone unique (sol, terrasse…)' },
];

// Catégories du protocole partagé (bibliothèque /protocolTemplates), par
// phase. Distinctes de EXIGENCE_SUGGESTION_CATEGORIES (qui ne sert que de
// point de départ pour les ajouts propres à un logement) : ici c'est le
// contenu réel appliqué à tous les logements.
export const PROTOCOL_CATEGORIES = [
  { key: 'preparation_generale', label: 'Préparation générale et linge', phase: 'avant' },
  { key: 'acces', label: 'Accès au logement', phase: 'avant' },
  { key: 'materiel', label: 'Matériel et produits de nettoyage', phase: 'avant' },
  { key: 'aeration', label: 'Aération du logement', phase: 'avant' },
  { key: 'equipements', label: 'Vérification des équipements', phase: 'avant' },
  { key: 'etat_initial', label: 'État initial du logement', phase: 'avant' },
  { key: 'equipements_dispo', label: 'Équipements mis à disposition', phase: 'avant' },
  { key: 'consommables', label: 'Consommables', phase: 'avant' },
  { key: 'parties_communes', label: 'Respect des parties communes', phase: 'avant' },
  { key: 'menage_preparation', label: 'Préparation générale', phase: 'menage' },
  { key: 'chambre', label: 'Chambres', phase: 'menage' },
  { key: 'salle_de_bain', label: 'Salles de bain', phase: 'menage' },
  { key: 'wc', label: 'WC', phase: 'menage' },
  { key: 'cuisine', label: 'Cuisine', phase: 'menage' },
  { key: 'salon', label: 'Salon', phase: 'menage' },
  { key: 'sols_entree', label: 'Sols et entrée', phase: 'menage' },
  { key: 'securite', label: 'Sécurité et équipements', phase: 'menage' },
  { key: 'terrasse', label: 'Terrasse', phase: 'menage' },
  { key: 'linge', label: 'Vérification du linge', phase: 'apres' },
  { key: 'chauffage_clim', label: 'Chauffage et climatisation', phase: 'apres' },
  { key: 'cles', label: 'Contrôle des clés', phase: 'apres' },
  { key: 'presentation', label: 'Présentation finale', phase: 'apres' },
  { key: 'entree', label: "Contrôle de l'entrée", phase: 'apres' },
  { key: 'parties_communes_apres', label: 'Parties communes', phase: 'apres' },
  { key: 'dechets', label: 'Gestion des déchets', phase: 'apres' },
];

export const PROTOCOL_GATE_FLAGS = [
  { key: null, label: 'Toujours (aucune condition)' },
  { key: 'hasSofaBed', label: "Si le logement a un canapé-lit" },
  { key: 'hasTerrace', label: 'Si le logement a une terrasse' },
  { key: 'hasClim', label: 'Si le logement a la climatisation' },
  { key: 'smokeDetectorCount', label: 'Selon le nombre de détecteurs de fumée' },
  { key: 'keyBoxCount', label: 'Selon le nombre de boîtes à clés' },
];

export const ANOMALY_CATEGORIES = [
  { key: 'linge_manquant', label: 'Linge manquant' },
  { key: 'equipement_defectueux', label: 'Équipement défectueux' },
  { key: 'telecommande_absente', label: 'Télécommande absente' },
  { key: 'consommables_insuffisants', label: 'Consommables insuffisants' },
  { key: 'moisissures', label: 'Moisissures' },
  { key: 'degradation_mobilier', label: 'Dégradation du mobilier' },
  { key: 'probleme_plomberie', label: 'Problème de plomberie' },
  { key: 'broken_object', label: 'Objet cassé' },
  { key: 'lost_object', label: 'Objet perdu' },
  { key: 'other', label: 'Autre' },
];

export const ANOMALY_URGENCY_LEVELS = [
  { key: 'faible', label: 'Faible' },
  { key: 'moyenne', label: 'Moyenne' },
  { key: 'urgente', label: 'Urgente' },
];

export const EXIGENCE_SUGGESTION_CATEGORIES = [
  { key: 'cuisine', label: 'Cuisine' },
  { key: 'salle_de_bain', label: 'Salle de bain' },
  { key: 'chambre', label: 'Chambre' },
  { key: 'electromenager', label: 'Électroménager' },
  { key: 'general', label: 'Général / zones communes' },
];

// Suggestions de départ, prêtes à l'emploi sans rien configurer : l'admin
// peut aussi enrichir sa propre bibliothèque (onglet Suggestions), qui se
// mélange à cette liste dans le sélecteur de l'éditeur d'exigences.
export const DEFAULT_EXIGENCE_SUGGESTIONS = [
  { category: 'cuisine', text: 'Nettoyer la vaisselle et ranger le lave-vaisselle', roomScope: 'none', requiresYesNo: true, requiresPhoto: false },
  { category: 'cuisine', text: 'Essuyer les plans de travail et la table', roomScope: 'none', requiresYesNo: true, requiresPhoto: false },
  { category: 'cuisine', text: 'Vider et nettoyer le réfrigérateur si besoin', roomScope: 'none', requiresYesNo: true, requiresPhoto: false },
  { category: 'cuisine', text: 'Photo du four et de la plaque de cuisson', roomScope: 'none', requiresYesNo: false, requiresPhoto: true },
  { category: 'cuisine', text: 'Sortir les poubelles et le recyclage', roomScope: 'none', requiresYesNo: true, requiresPhoto: false },
  { category: 'salle_de_bain', text: 'Nettoyer et désinfecter les toilettes', roomScope: 'bathroom', requiresYesNo: true, requiresPhoto: false },
  { category: 'salle_de_bain', text: 'Changer les serviettes', roomScope: 'bathroom', requiresYesNo: true, requiresPhoto: false },
  { category: 'salle_de_bain', text: 'Photo de la douche ou de la baignoire nettoyée', roomScope: 'bathroom', requiresYesNo: false, requiresPhoto: true },
  { category: 'salle_de_bain', text: 'Vérifier le niveau de papier toilette', roomScope: 'bathroom', requiresYesNo: true, requiresPhoto: false },
  { category: 'chambre', text: 'Faire le lit avec du linge propre', roomScope: 'bedroom', requiresYesNo: true, requiresPhoto: false },
  { category: 'chambre', text: 'Dépoussiérer les surfaces', roomScope: 'bedroom', requiresYesNo: true, requiresPhoto: false },
  { category: 'chambre', text: 'Photo de la chambre rangée', roomScope: 'bedroom', requiresYesNo: false, requiresPhoto: true },
  { category: 'electromenager', text: 'Photo du tambour de la machine à laver vide', roomScope: 'none', requiresYesNo: false, requiresPhoto: true },
  { category: 'electromenager', text: 'Vérifier et nettoyer le filtre du lave-linge', roomScope: 'none', requiresYesNo: true, requiresPhoto: false },
  { category: 'electromenager', text: 'Vider le filtre du sèche-linge', roomScope: 'none', requiresYesNo: true, requiresPhoto: false },
  { category: 'general', text: 'Aspirer et laver les sols', roomScope: 'none', requiresYesNo: true, requiresPhoto: false },
  { category: 'general', text: 'Vérifier que le wifi fonctionne', roomScope: 'none', requiresYesNo: true, requiresPhoto: false },
  { category: 'general', text: 'Photo générale du salon rangé', roomScope: 'none', requiresYesNo: false, requiresPhoto: true },
  { category: 'general', text: "Vérifier qu'il ne manque pas d'ampoules", roomScope: 'none', requiresYesNo: true, requiresPhoto: false },
];

// Bibliothèque standard du protocole (cahiers des charges Avant Ménage /
// Ménage / Après Ménage) : contenu RÉEL appliqué à tous les logements via
// computeChecklistItems(), pas de simples suggestions. Chaque lettre du
// document Avant Ménage devient une ou plusieurs entrées ici ; une lettre
// qui regroupe plusieurs vérifications indépendantes sous un seul "Oui/
// Non" est éclatée en items distincts (ex. D : éclairages ET wifi) pour
// que le signalement d'anomalie reste précis — c'est l'esprit même du
// document (§1 : "éviter les litiges", traçabilité par point de contrôle).
// Les phases Ménage et Après Ménage sont ajoutées dans les phases
// suivantes du développement, pas encore ici.
export const DEFAULT_PROTOCOL_TEMPLATES = [
  // --- AVANT MÉNAGE (document 1) ---
  {
    phase: 'avant', category: 'acces', order: 0,
    text: 'Photographier les clés présentes dans la boîte à clés et vérifier leur présence',
    roomScope: 'none', requiresYesNo: true, requiresPhoto: true,
  },
  {
    phase: 'avant', category: 'materiel', order: 0,
    text: 'Photographier les produits et le matériel de nettoyage disponibles (désinfectant, anticalcaire, microfibres, éponges, autres équipements nécessaires)',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'avant', category: 'aeration', order: 0,
    text: 'Ouvrir les fenêtres des pièces concernées et photographier l’aération du logement',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'avant', category: 'equipements', order: 0,
    text: 'Contrôler le fonctionnement des éclairages',
    roomScope: 'none', requiresYesNo: true,
  },
  {
    phase: 'avant', category: 'equipements', order: 1,
    text: 'Vérifier la connexion Wi-Fi',
    roomScope: 'none', requiresYesNo: true,
  },
  {
    phase: 'avant', category: 'etat_initial', order: 0,
    text: 'Vérifier l’absence d’objets oubliés par les précédents occupants',
    roomScope: 'none', requiresYesNo: true,
  },
  {
    phase: 'avant', category: 'etat_initial', order: 1,
    text: 'Vérifier l’absence de dégradations visibles',
    roomScope: 'none', requiresYesNo: true,
  },
  {
    phase: 'avant', category: 'etat_initial', order: 2,
    text: 'Vérifier l’absence d’odeurs inhabituelles (cigarette, humidité, etc.)',
    roomScope: 'none', requiresYesNo: true,
  },
  {
    phase: 'avant', category: 'equipements_dispo', order: 0,
    text: 'Photographier les équipements mis à disposition (aspirateur, fer et table à repasser, étendoir, équipements bébé le cas échéant, couettes et oreillers supplémentaires)',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'avant', category: 'consommables', order: 0,
    text: 'Contrôler les stocks de consommables (papier toilette, essuie-tout, savon, gel douche, shampooing, après-shampooing, café, thé, sucre, autres consommables prévus) et signaler les quantités insuffisantes',
    roomScope: 'none', requiresConfirmation: true,
  },
  {
    phase: 'avant', category: 'parties_communes', order: 0,
    text: 'Confirmer qu’aucun matériel, sac de linge ou déchet n’est déposé dans les parties communes de l’immeuble',
    roomScope: 'none', requiresConfirmation: true,
  },

  // --- MÉNAGE (document 2) ---
  {
    phase: 'menage', category: 'menage_preparation', order: 0,
    text: 'Détartrer et désinfecter les surfaces (robinetterie, parois de douche, joints) — respecter 10 min de temps d’action',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'menage_preparation', order: 1,
    text: 'Vérifier que le linge livré correspond à la configuration du logement (quantités, propreté, absence de taches ou de détérioration)',
    roomScope: 'none', requiresYesNo: true, requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'menage_preparation', order: 2,
    text: 'Désinfecter les WC (produit adapté, 10 min de temps d’action)',
    roomScope: 'wc', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'menage_preparation', order: 3,
    text: 'Vérifier l’absence de moisissures (joints, murs, plafonds) et le bon fonctionnement de la VMC',
    roomScope: 'none', requiresYesNo: true,
  },

  {
    phase: 'menage', category: 'chambre', order: 0,
    text: 'Vérifier la propreté et la présence d’une alèse propre sur chaque matelas, photographier le matelas avec l’alèse visible',
    roomScope: 'bedroom', requiresYesNo: true, requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'chambre', order: 1,
    text: 'Nettoyer et dépoussiérer le mobilier (placards, bureaux, étagères, interrupteurs, poignées, luminaires, tiroirs)',
    roomScope: 'bedroom', requiresConfirmation: true, requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'chambre', order: 2,
    text: 'Préparer le lit (linge propre, présentation soignée) et disposer les serviettes prévues, photographier le résultat',
    roomScope: 'bedroom', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'chambre', order: 3,
    text: 'Contrôle final de la chambre (propreté, rangement, absence d’objets oubliés, présentation)',
    roomScope: 'bedroom', requiresPhoto: true,
  },

  {
    phase: 'menage', category: 'salle_de_bain', order: 0,
    text: 'Nettoyer les joints (traces de savon et de calcaire)',
    roomScope: 'bathroom', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'salle_de_bain', order: 1,
    text: 'Nettoyer la douche ou la baignoire (parois, robinetterie, receveur, traces de savon et de calcaire)',
    roomScope: 'bathroom', requiresConfirmation: true,
  },
  {
    phase: 'menage', category: 'salle_de_bain', order: 2,
    text: 'Contrôle du siphon',
    roomScope: 'bathroom',
    photoSlots: ['Siphon ouvert, avec de l’eau visible, après nettoyage', 'Siphon correctement refermé et remis en place'],
  },
  {
    phase: 'menage', category: 'salle_de_bain', order: 3,
    text: 'Présentation finale de la douche (pommeau, tapis de bain, joints, propreté générale)',
    roomScope: 'bathroom', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'salle_de_bain', order: 4,
    text: 'Vérifier le sèche-serviettes et l’éteindre conformément aux instructions du logement',
    roomScope: 'bathroom', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'salle_de_bain', order: 5,
    text: 'Vérifier la présence et le niveau des produits d’accueil (gel douche, shampooing, après-shampooing, savon mains), disposés comme la référence',
    roomScope: 'bathroom', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'salle_de_bain', order: 6,
    text: 'Vérifier, tester et nettoyer le sèche-cheveux, le ranger à son emplacement prévu',
    roomScope: 'bathroom', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'salle_de_bain', order: 7,
    text: 'Nettoyer le porte-savon (calcaire, résidus de savon)',
    roomScope: 'bathroom', requiresPhoto: true,
  },

  {
    phase: 'menage', category: 'wc', order: 0,
    text: 'Nettoyer les toilettes (cuvette, abattant, chasse d’eau, support et brosse, recharge de papier toilette)',
    roomScope: 'wc', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'wc', order: 1,
    text: 'Vérifier que la brosse WC est propre, en bon état et correctement rangée',
    roomScope: 'wc', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'wc', order: 2,
    text: 'Vérifier la réserve de papier toilette (3 rouleaux disponibles, dont celui installé)',
    roomScope: 'wc', requiresPhoto: true,
  },

  {
    phase: 'menage', category: 'cuisine', order: 0,
    text: 'Nettoyer et ranger la vaisselle, vider et remplir la carafe d’eau',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'cuisine', order: 1,
    text: 'Vérifier la propreté des casseroles et poêles, nettoyer et ranger si nécessaire',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'cuisine', order: 2,
    text: 'Nettoyer et ranger le placard sous évier (sacs-poubelle, pelle et balayette, bassine, lessive, pastilles et sel lave-vaisselle, liquide de rinçage, matériel de lavage des sols)',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'cuisine', order: 3,
    text: 'Nettoyer l’intérieur du réfrigérateur et vérifier la présence de la bouteille d’eau prévue',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'cuisine', order: 4,
    text: 'Vider et nettoyer l’intérieur du lave-vaisselle',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'cuisine', order: 5,
    text: 'Vider la machine à laver, nettoyer le joint, le tiroir à lessive et le hublot',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'cuisine', order: 6,
    text: 'Tester, nettoyer et ranger le petit électroménager (bouilloire, machine à café, grille-pain)',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'cuisine', order: 7,
    text: 'Nettoyer l’intérieur du four et du micro-ondes',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'cuisine', order: 8,
    text: 'Vérifier la réserve de sacs-poubelle destinés au client',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'cuisine', order: 9,
    text: 'Vérifier les produits de cuisine (liquide vaisselle, éponge, torchon, essuie-tout)',
    roomScope: 'none', requiresPhoto: true,
  },

  {
    phase: 'menage', category: 'salon', order: 0,
    text: 'Nettoyer et ranger le salon (dépoussiérer, mobilier, chaises, télécommandes, rideaux, lampes)',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'salon', order: 1,
    text: 'Ouvrir le canapé-lit, vérifier sa propreté et la présence d’une alèse',
    roomScope: 'none', requiresPhoto: true, gateFlag: 'hasSofaBed',
  },
  {
    phase: 'menage', category: 'salon', order: 2,
    text: 'Présenter le canapé (coussins, éléments décoratifs) conformément à la photo de référence',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'salon', order: 3,
    text: 'Vérifier la présence de la télécommande de climatisation',
    roomScope: 'none', requiresYesNo: true, gateFlag: 'hasClim',
  },
  {
    phase: 'menage', category: 'salon', order: 4,
    text: 'Allumer la télévision, vérifier son fonctionnement et tester la télécommande',
    roomScope: 'none', requiresPhoto: true,
  },

  {
    phase: 'menage', category: 'sols_entree', order: 0,
    text: 'Aspirer l’ensemble du logement, y compris sous les meubles accessibles',
    roomScope: 'none', requiresConfirmation: true,
  },
  {
    phase: 'menage', category: 'sols_entree', order: 1,
    text: 'Laver les sols de toutes les pièces accessibles',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'menage', category: 'sols_entree', order: 2,
    text: 'Nettoyer l’entrée du logement (porte, poignées, murs accessibles, sol)',
    roomScope: 'none', requiresConfirmation: true,
  },

  {
    phase: 'menage', category: 'securite', order: 0,
    text: 'Vérifier la présence du détecteur de fumée et photographier son emplacement',
    roomScope: 'smoke_detector', requiresPhoto: true,
  },

  {
    phase: 'menage', category: 'terrasse', order: 0,
    text: 'Nettoyer la terrasse (mobilier, balayage, déchets, objets abandonnés, mobilier remis en place)',
    roomScope: 'none', requiresPhoto: true, gateFlag: 'hasTerrace',
  },

  // --- APRÈS MÉNAGE (document 3) ---
  // key sert uniquement à ce tableau (résolu en vrai itemId Firestore à
  // l'import, voir importDefaultProtocols dans admin.js) : dependsOn ne
  // peut pas connaître d'avance l'id auto-généré de l'item dont il dépend.
  {
    phase: 'apres', category: 'linge', order: 0, key: 'apres_linge_tache',
    text: 'Le linge est-il taché ?',
    roomScope: 'none', requiresYesNo: true,
  },
  {
    phase: 'apres', category: 'linge', order: 1,
    text: 'Avez-vous résolu le problème et remplacé le linge taché ?',
    roomScope: 'none', requiresYesNo: true,
    dependsOn: { key: 'apres_linge_tache', equals: true },
  },
  {
    phase: 'apres', category: 'chauffage_clim', order: 0,
    text: 'Vérifier le réglage du chauffage et de la climatisation selon les instructions du logement (voir standard de température dans la fiche du logement)',
    roomScope: 'none', requiresYesNo: true, requiresPhoto: true,
  },
  {
    phase: 'apres', category: 'cles', order: 0,
    text: 'Photographier la boîte à clés (présence, rangement, fermeture) conformément à la référence',
    roomScope: 'key_box', requiresPhoto: true,
  },
  {
    phase: 'apres', category: 'presentation', order: 0,
    text: 'Ouvrir et positionner correctement les rideaux',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'apres', category: 'presentation', order: 1,
    text: 'Fermer et vérifier toutes les fenêtres',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'apres', category: 'entree', order: 0,
    text: 'Contrôle final de l’entrée (propreté, rangement, présentation, absence de matériel oublié)',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'apres', category: 'parties_communes_apres', order: 0,
    text: 'Vérifier les parties communes de l’immeuble (déchets, sacs de linge, matériel de nettoyage)',
    roomScope: 'none', requiresPhoto: true,
  },
  {
    phase: 'apres', category: 'dechets', order: 0,
    text: 'Évacuer les déchets en respectant le tri sélectif et les emplacements prévus',
    roomScope: 'none', requiresConfirmation: true, requiresPhoto: true, allowsComment: true,
  },
];

const configMissing = Object.values(firebaseConfig).some(value => String(value).startsWith('REPLACE'));
if (configMissing) {
  const renderNotice = () => {
    document.body.innerHTML = `
      <div style="max-width:560px;margin:80px auto;padding:36px;font-family:sans-serif;border:1px solid #DCE1EE;border-radius:8px;background:#fff;color:#10131A;">
        <div style="font-family:monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#002FA7;margin-bottom:12px;">Zebramoon, configuration requise</div>
        <h1 style="font-size:20px;margin:0 0 12px;">Firebase n'est pas encore configuré</h1>
        <p style="line-height:1.6;color:#5A6472;">Copiez la configuration web de votre projet Firebase dans <code>firebase-config.js</code>, puis rechargez la page. Les étapes complètes sont dans <code>SETUP.md</code>.</p>
      </div>`;
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNotice);
  } else {
    renderNotice();
  }
  throw new Error('Firebase non configuré, voir SETUP.md');
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
// Stockage : Cloudflare R2 (voir r2-upload.js), pas Firebase Storage — le
// plan Spark de ce projet n'a jamais eu Storage activé (nécessite Blaze).
// objectKey remplace downloadUrl : les URLs R2 sont privées et signées à la
// demande (resolvePhotoUrl dans r2-upload.js), pas permanentes.
export async function uploadBookingImage({ bookingId, slot, file, uploadedBy }) {
  const normalizedSlot = slot.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const objectKey = await uploadPhotoToR2({ bookingId, scope: 'bookings', file });
  const photoDoc = {
    bookingId,
    slot: normalizedSlot,
    uploadedBy,
    objectKey,
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

// Photo de référence d'une exigence (rédaction admin) → renvoie l'URL,
// même logique que uploadCatalogImage.
export async function uploadExigenceReferenceImage(file) {
  const safe = (file.name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_');
  const storageRef = ref(storage, `exigences/${Date.now()}-${safe}`);
  await uploadBytes(storageRef, file, { contentType: file.type || 'image/jpeg' });
  return getDownloadURL(storageRef);
}

export async function loadExigencesForProperty(propertyId) {
  const snap = await getDocs(query(collection(db, 'exigences'), where('propertyId', '==', propertyId)));
  return snap.docs
    .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
    .filter(item => item.active !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function loadExigenceAnswers(bookingId) {
  const snap = await getDocs(query(collection(db, 'exigenceAnswers'), where('bookingId', '==', bookingId)));
  return snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
}

// Id déterministe : un nouvel envoi (photo ou oui/non) remplace la réponse
// précédente pour cette exigence (et, pour une exigence par pièce, cette
// pièce précise) sur cette mission, même logique que la photo en slot fixe.
export function exigenceAnswerDocId(bookingId, exigenceId, roomIndex, slotIndex = null) {
  const base = roomIndex == null ? `${bookingId}_${exigenceId}` : `${bookingId}_${exigenceId}_${roomIndex}`;
  return slotIndex == null ? base : `${base}_s${slotIndex}`;
}

// Une exigence « par pièce » (roomScope bedroom/bathroom/wc) se répète une
// fois par pièce RÉELLE de la réservation (bedrooms/bathrooms/wcCount,
// recopiés sur le booking au moment de la réservation — pas une relecture
// du logement, pour qu'une mission en cours ne bouge pas si le logement
// est modifié entre-temps). Une exigence 'none'/'other' n'a qu'une
// instance.
// Chaque entrée répétable associe son roomScope au champ de comptage gelé
// sur le booking (voir booking-flow.js) et au mot utilisé pour numéroter
// les instances (Chambre 1, Détecteur 2…).
const REPEATABLE_ROOM_SCOPES = {
  bedroom: { countField: 'bedrooms', word: 'Chambre' },
  bathroom: { countField: 'bathrooms', word: 'Salle de bain' },
  wc: { countField: 'wcCount', word: 'WC' },
  smoke_detector: { countField: 'smokeDetectorCount', word: 'Détecteur' },
  key_box: { countField: 'keyBoxCount', word: 'Boîte à clés' },
};

export function exigenceInstances(exigence, booking) {
  const repeat = REPEATABLE_ROOM_SCOPES[exigence.roomScope];
  if (repeat) {
    const count = Math.max(0, Number(booking[repeat.countField]) || 0);
    return Array.from({ length: count }, (_, i) => ({ roomIndex: i, label: `${repeat.word} ${i + 1}` }));
  }
  return [{ roomIndex: null, label: null }];
}

// Écrit en merge (pas en remplacement) : une exigence peut demander à la
// fois une réponse oui/non ET une photo, saveExigenceYesNo et
// uploadExigenceAnswerImage doivent pouvoir s'écrire sans s'effacer l'un
// l'autre.
export async function saveExigenceYesNo({ bookingId, exigenceId, propertyId, roomIndex = null, answeredBy, answerYesNo }) {
  const id = exigenceAnswerDocId(bookingId, exigenceId, roomIndex);
  const answerDoc = { bookingId, exigenceId, propertyId, roomIndex, answeredBy, answerYesNo, answeredAt: serverTimestamp() };
  await setDoc(doc(db, 'exigenceAnswers', id), answerDoc, { merge: true });
  return answerDoc;
}

// Mode 1 (confirmation simple) : une case "fait", sans sémantique oui/non
// (donc pas de branche anomalie automatique, contrairement à saveExigenceYesNo).
export async function saveExigenceConfirmation({ bookingId, exigenceId, propertyId, roomIndex = null, answeredBy }) {
  const id = exigenceAnswerDocId(bookingId, exigenceId, roomIndex);
  const answerDoc = { bookingId, exigenceId, propertyId, roomIndex, answeredBy, confirmed: true, answeredAt: serverTimestamp() };
  await setDoc(doc(db, 'exigenceAnswers', id), answerDoc, { merge: true });
  return answerDoc;
}

// Commentaire libre sur une exigence (ex. "préciser les difficultés
// rencontrées" pour les déchets, après ménage) : purement informatif, ne
// compte jamais dans exigenceAnswerStats/required-done, donc ne bloque
// jamais la progression ni l'envoi du dossier.
export async function saveExigenceComment({ bookingId, exigenceId, propertyId, roomIndex = null, answeredBy, commentText }) {
  const id = exigenceAnswerDocId(bookingId, exigenceId, roomIndex);
  const answerDoc = { bookingId, exigenceId, propertyId, roomIndex, answeredBy, commentText, answeredAt: serverTimestamp() };
  await setDoc(doc(db, 'exigenceAnswers', id), answerDoc, { merge: true });
  return answerDoc;
}

// slotIndex distingue plusieurs photos exigées par la MÊME tâche (ex. le
// siphon : une photo ouvert, une photo refermé, deux validations séparées) —
// omis pour une tâche à photo unique, l'id reste identique à avant.
// photoKey (objectKey R2) remplace photoUrl : stockage privé, voir
// resolvePhotoUrl / r2-upload.js pour l'affichage.
export async function uploadExigenceAnswerImage({ bookingId, exigenceId, propertyId, roomIndex = null, slotIndex = null, file, answeredBy }) {
  const id = exigenceAnswerDocId(bookingId, exigenceId, roomIndex, slotIndex);
  const photoKey = await uploadPhotoToR2({ bookingId, scope: 'bookings', file });
  const answerDoc = { bookingId, exigenceId, propertyId, roomIndex, slotIndex, answeredBy, photoKey, answeredAt: serverTimestamp() };
  await setDoc(doc(db, 'exigenceAnswers', id), answerDoc, { merge: true });
  return answerDoc;
}

export async function loadProtocolTemplates() {
  const snap = await getDocs(collection(db, 'protocolTemplates'));
  return snap.docs
    .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

// Id déterministe : au plus une surcharge par couple logement/modèle, un
// nouvel enregistrement remplace le précédent (même logique que les autres
// collections à id composé de ce fichier).
export function propertyTemplateOverrideDocId(propertyId, templateId) {
  return `${propertyId}_${templateId}`;
}

export async function loadPropertyTemplateOverrides(propertyId) {
  const snap = await getDocs(query(collection(db, 'propertyTemplateOverrides'), where('propertyId', '==', propertyId)));
  return snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function savePropertyTemplateOverride(propertyId, templateId, data) {
  const id = propertyTemplateOverrideDocId(propertyId, templateId);
  const overrideDoc = { propertyId, templateId, ...data, updatedAt: serverTimestamp() };
  await setDoc(doc(db, 'propertyTemplateOverrides', id), overrideDoc, { merge: true });
  return overrideDoc;
}

// Remet un point de contrôle dans son état par défaut pour ce logement
// (plus de masquage, plus de reformulation, photo de référence standard).
export async function clearPropertyTemplateOverride(propertyId, templateId) {
  const id = propertyTemplateOverrideDocId(propertyId, templateId);
  await deleteDoc(doc(db, 'propertyTemplateOverrides', id));
}

function protocolGateSatisfied(gateFlag, booking) {
  if (!gateFlag) return true;
  const value = booking[gateFlag];
  return typeof value === 'number' ? value > 0 : !!value;
}

function normalizeProtocolTemplate(template) {
  return {
    id: template.id,
    source: 'template',
    phase: template.phase,
    category: template.category || null,
    order: template.order || 0,
    text: template.text,
    instructions: template.instructions || '',
    roomScope: template.roomScope || 'none',
    requiresConfirmation: !!template.requiresConfirmation,
    requiresYesNo: !!template.requiresYesNo,
    requiresPhoto: !!template.requiresPhoto,
    photoSlots: template.photoSlots && template.photoSlots.length ? template.photoSlots : null,
    referencePhotoUrl: (template.referencePhotoUrls && template.referencePhotoUrls[0]) || template.referencePhotoUrl || '',
    referencePhotoUrls: template.referencePhotoUrls && template.referencePhotoUrls.length ? template.referencePhotoUrls : null,
    allowsComment: !!template.allowsComment,
    dependsOn: template.dependsOn || null,
    active: template.active,
  };
}

function normalizeCustomExigence(item) {
  return {
    id: item.id,
    source: 'custom',
    phase: item.phase,
    category: null,
    order: item.order || 0,
    text: item.text,
    instructions: '',
    roomScope: item.roomScope || 'none',
    requiresConfirmation: false,
    requiresYesNo: !!item.requiresYesNo,
    requiresPhoto: !!item.requiresPhoto,
    photoSlots: null,
    referencePhotoUrl: item.referencePhotoUrl || '',
    referencePhotoUrls: null,
    dependsOn: null,
    active: item.active,
  };
}

// Fusionne la bibliothèque PARTAGÉE (protocolTemplates, filtrée par
// équipements du logement via gateFlag, et par dépendance via dependsOn)
// avec les AJOUTS propres à ce logement (exigences, inchangés) : une seule
// liste normalisée, peu importe la source, que le rendu prestataire
// consomme ensuite via exigenceInstances/buildExigenceRow comme avant.
// `answers` (map answerDocId -> réponse) permet de résoudre dependsOn ;
// recalculé à chaque rendu, donc une question de relance (ex. "avez-vous
// résolu le problème ?") apparaît ou disparaît en direct selon la réponse
// qui la conditionne.
// Applique une surcharge PAR LOGEMENT (propertyTemplateOverrides) sur un
// modèle déjà normalisé : masquage total, reformulation, ou remplacement
// de la/les photo(s) de référence — jamais les champs de validation
// (requiresYesNo/Photo/Confirmation, photoSlots), qui restent définis au
// niveau du modèle partagé pour ne pas faire diverger le sens de la tâche
// d'un logement à l'autre.
function applyTemplateOverride(item, override) {
  if (!override) return item;
  const next = { ...item };
  if (override.textOverride) next.text = override.textOverride;
  if (override.referencePhotoUrlOverride) next.referencePhotoUrl = override.referencePhotoUrlOverride;
  if (override.referencePhotoUrlsOverride && override.referencePhotoUrlsOverride.length) {
    next.referencePhotoUrls = override.referencePhotoUrlsOverride;
    next.referencePhotoUrl = override.referencePhotoUrlsOverride[0];
  }
  return next;
}

export function computeChecklistItems(booking, templates, customExigences, answers = {}, overrides = []) {
  const overrideByTemplateId = {};
  (overrides || []).forEach(o => { overrideByTemplateId[o.templateId] = o; });
  const fromTemplates = (templates || [])
    .filter(t => t.active !== false)
    .filter(t => protocolGateSatisfied(t.gateFlag, booking))
    .filter(t => !(overrideByTemplateId[t.id] && overrideByTemplateId[t.id].hidden))
    .filter(t => {
      if (!t.dependsOn) return true;
      const depAnswer = answers[exigenceAnswerDocId(booking.id, t.dependsOn.itemId, null)];
      return !!depAnswer && depAnswer.answerYesNo === t.dependsOn.equals;
    })
    .map(normalizeProtocolTemplate)
    .map(item => applyTemplateOverride(item, overrideByTemplateId[item.id]));
  const fromCustom = (customExigences || [])
    .filter(e => e.active !== false)
    .map(normalizeCustomExigence);
  return [...fromTemplates, ...fromCustom].sort((a, b) => (a.order || 0) - (b.order || 0));
}

// Chronomètre de mission (un document par réservation, id = bookingId).
// startedAt/pausedAt sont des Date.now() côté client, pas serverTimestamp() :
// c'est un repère personnel affiché au prestataire pendant qu'il travaille,
// pas une preuve horodatée, donc pas besoin d'un aller-retour serveur pour
// calculer le temps écoulé pendant que le chrono tourne.
export async function loadBookingTimer(bookingId) {
  const snap = await getDoc(doc(db, 'bookingTimers', bookingId));
  return snap.exists() ? snap.data() : null;
}

export async function startBookingTimer({ bookingId, prestataireId, resumeFrom = 0 }) {
  const timerDoc = { bookingId, prestataireId, startedAt: Date.now(), pausedAt: null, totalElapsedSeconds: resumeFrom, status: 'running' };
  await setDoc(doc(db, 'bookingTimers', bookingId), timerDoc);
  return timerDoc;
}

export async function pauseBookingTimer({ bookingId, prestataireId, startedAt, totalElapsedSeconds }) {
  const elapsed = (totalElapsedSeconds || 0) + Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const timerDoc = { bookingId, prestataireId, startedAt: null, pausedAt: Date.now(), totalElapsedSeconds: elapsed, status: 'paused' };
  await setDoc(doc(db, 'bookingTimers', bookingId), timerDoc);
  return timerDoc;
}

// Notes du prestataire sur une mission (indépendant des incidents, réservés
// aux problèmes à signaler).
export async function loadBookingComments(bookingId) {
  const snap = await getDocs(query(collection(db, 'bookingComments'), where('bookingId', '==', bookingId)));
  return snap.docs
    .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
    .sort((a, b) => (b.createdAt?.toMillis?.() || b.createdAt || 0) - (a.createdAt?.toMillis?.() || a.createdAt || 0));
}

export async function addBookingComment({ bookingId, authorId, text }) {
  const commentDoc = { bookingId, authorId, text, read: false, createdAt: serverTimestamp() };
  const ref2 = await addDoc(collection(db, 'bookingComments'), commentDoc);
  return { id: ref2.id, ...commentDoc };
}

// Décomposition du prix CÔTÉ CLIENT uniquement (prestation/kits/amenities/
// suppléments/commission/déplacement/TVA/TTC) : volontairement SANS
// prestatairePay/adjustment (rémunération du prestataire, réservée à
// l'admin dans la compta) tant que l'équipe n'a pas confirmé que le
// prestataire doit voir sa propre paie par mission.
export function buildClientPriceBreakdown(booking) {
  const price = Number(booking.price) || 0;
  const prestation = Number(booking.prestationPrice) || 0;
  const travel = Number(booking.travelFee) || 0;
  const amenities = Number(booking.amenitiesPrice) || 0;
  const extrasHT = Number(booking.extrasHT) || 0;
  const commission = Number(booking.commission) || 0;
  const kits = Math.max(0, price - prestation - amenities - extrasHT - commission - travel);
  const rooms = Number(booking.bedrooms != null ? booking.bedrooms : booking.kitCount) || 0;
  const rate = getPricing().vatRate;
  const vat = Math.round(price * rate);

  const hstr = booking.hours ? `${String(booking.hours).replace('.', ',')} h · ` : '';
  const rows = [[`Prestation · ${hstr}${booking.surface ? `${booking.surface} m²` : ''}`.replace(/· $/, ''), prestation]];
  if (kits) rows.push([`Kits de bienvenue${rooms ? ` · ${rooms} chambre${rooms > 1 ? 's' : ''}` : ''}`, kits]);
  rows.push(['Amenities (consommables)', amenities]);
  (booking.extras || []).forEach(e => {
    rows.push([`${e.name || 'Supplément'}${e.qty > 1 ? ` × ${e.qty}` : ''}`, (Number(e.priceHT) || 0) * (Number(e.qty) || 0)]);
  });
  if (commission) rows.push(['Commission Zebramoon', commission]);
  if (travel) rows.push(['Frais de déplacement', travel]);
  rows.push(['Total HT', price, 'pb-total']);
  rows.push([`TVA (${Math.round(rate * 100)} %)`, vat, '']);
  rows.push(['Total TTC (payé par le client)', price + vat, 'pb-warn']);

  const wrap = document.createElement('div');
  wrap.className = 'price-breakdown';
  rows.forEach(([label, amount, cls]) => {
    const line = document.createElement('div');
    line.className = `pb-line ${cls || ''}`.trim();
    const span = document.createElement('span');
    span.textContent = label;
    const b = document.createElement('b');
    b.textContent = `${amount}€`;
    line.append(span, b);
    wrap.appendChild(line);
  });
  return wrap;
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
  // Nettoyage volontairement NON attendu : deleteApp peut ne jamais se résoudre
  // tant que Firestore garde une connexion ouverte, ce qui bloquerait le bouton
  // (le spinner ne s'arrête qu'à la fin de la fonction). On le lance en arrière-plan.
  const cleanup = () => {
    signOut(secondaryAuth).catch(() => {});
    deleteApp(secondary).catch(() => {});
  };
  try {
    // Toutes les étapes sont bornées : aucune ne peut faire tourner le spinner
    // indéfiniment (réseau lent sur mobile, règles, etc.).
    const credential = await withTimeout(createUserWithEmailAndPassword(secondaryAuth, email, password), 20000);
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
        subject: `Zebramoon, nouvelle demande d’accès ${role}`,
        text: `${name} (${email}, ${phone}) demande un accès ${role}.${inviteCode ? ` Code d’invitation saisi : ${inviteCode}.` : ' Aucun code d’invitation saisi.'} À traiter dans /admin/.`,
      },
      createdAt: serverTimestamp(),
    }), 10000).catch(() => {});
    return credential.user.uid;
  } finally {
    cleanup();
  }
}

// E-mail de réinitialisation du mot de passe (flux natif Firebase).
export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

// File d'envoi d'e-mails : dépose un document dans la collection `mail`,
// que l'extension Firebase « Trigger Email » transforme en vrai e-mail
// (voir SETUP.md). Sans l'extension, les documents s'accumulent sans effet, // l'action métier n'échoue jamais à cause d'un e-mail.
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
