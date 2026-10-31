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

// Logo Zebramoon encodé en data URI (fond noir plein, carré) pour les
// documents imprimables ci-dessous : ouverts via window.open + document.write,
// sans base href fiable vers /assets, donc une URL relative casserait l'image.
// Sur papier blanc le cadre noir reste visible (le mark est en ivoire/blanc, il
// serait invisible sans fond sombre) — contrairement à l'usage à l'écran, où le
// même mark se détoure sur le fond noir du site.
const LOGO_PRINT_DATA_URI = 'data:image/png;base64,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';

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
  .brand{ display:flex; align-items:center; }
  .brand img{ height:58px; width:auto; border-radius:4px; }
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
  @media print{ body{ padding:24px; } .noprint{ display:none; } }
  .noprint{ margin-top:26px; }
  .noprint button{ background:#E6007E; color:#fff; border:none; border-radius:4px; padding:11px 20px; font-size:14px; font-weight:700; cursor:pointer; }
</style></head><body>
  <div class="top">
    <div class="brand">
      <img src="${LOGO_PRINT_DATA_URI}" alt="Zebramoon">
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
    .brand { display:inline-block; }
    .brand img { height:64px; width:auto; border-radius:4px; }
    .sub { color:#6E6656; margin-top:10px; font-size:14px; }
    .qr { display:inline-block; margin:26px auto 14px; padding:18px; border:1px solid #E4DBC7; border-radius:4px; }
    .qr svg { width:280px; height:280px; display:block; }
    .ref { font-weight:700; font-size:18px; letter-spacing:0.04em; }
    .addr { color:#6E6656; margin-top:6px; font-size:14px; }
    .hint { max-width:340px; margin:22px auto 0; color:#1A160F; font-size:14px; line-height:1.5; }
    .noprint button { margin-top:24px; padding:10px 16px; border:0; border-radius:4px; background:#E6007E; color:#fff; font-weight:700; cursor:pointer; }
    @media print { .noprint { display:none; } }
  </style></head>
  <body>
    <div class="brand"><img src="${LOGO_PRINT_DATA_URI}" alt="Zebramoon"></div>
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
