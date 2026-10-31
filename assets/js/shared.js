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
  body{ font-family:'Italiana','Cormorant Garamond',Georgia,serif; color:#1A160F; padding:40px 46px; font-size:14px; }
  .top{ display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:34px; }
  .brand{ display:flex; align-items:center; }
  .brand img{ height:66px; width:auto; border-radius:4px; }
  .doc-meta{ text-align:right; font-size:13px; color:#555; font-family:'Helvetica Neue',Arial,sans-serif; }
  .doc-meta h1{ font-family:'Italiana','Cormorant Garamond',Georgia,serif; font-size:24px; letter-spacing:2px; color:#1A160F; margin-bottom:6px; }
  .parties{ display:flex; justify-content:space-between; gap:30px; margin-bottom:26px; font-family:'Helvetica Neue',Arial,sans-serif; }
  .parties h3{ font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#1A160F; margin-bottom:6px; }
  .parties div{ font-size:13px; line-height:1.5; color:#333; }
  table{ width:100%; border-collapse:collapse; margin-bottom:20px; font-family:'Helvetica Neue',Arial,sans-serif; }
  th{ text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#888; border-bottom:2px solid #1A160F; padding:8px 0; }
  th.amt, td.amt{ text-align:right; white-space:nowrap; }
  td{ padding:11px 0; border-bottom:1px solid #E4DBC7; }
  .totals{ margin-left:auto; width:280px; font-family:'Helvetica Neue',Arial,sans-serif; }
  .totals .row{ display:flex; justify-content:space-between; padding:7px 0; font-size:14px; }
  .totals .ttc{ border-top:2px solid #1A160F; margin-top:4px; padding-top:12px; font-size:18px; font-weight:800; color:#1A160F; }
  .foot{ margin-top:38px; font-size:11px; color:#888; line-height:1.6; border-top:1px solid #E4DBC7; padding-top:16px; font-family:'Helvetica Neue',Arial,sans-serif; }
  @media print{ body{ padding:24px; } .noprint{ display:none; } }
  .noprint{ margin-top:26px; }
  .noprint button{ background:#1A160F; color:#fff; border:none; border-radius:4px; padding:11px 20px; font-size:14px; font-weight:700; cursor:pointer; font-family:'Helvetica Neue',Arial,sans-serif; }
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
    body { font-family:'Helvetica Neue', Arial, sans-serif; color:#1A160F; text-align:center; padding:32px 24px; }
    .brand { display:inline-block; }
    .brand img { height:76px; width:auto; border-radius:4px; }
    .sub { color:#6E6656; margin-top:10px; font-size:14px; }
    .qr { display:inline-block; margin:26px auto 14px; padding:18px; border:1px solid #E4DBC7; border-radius:4px; }
    .qr svg { width:280px; height:280px; display:block; }
    .ref { font-weight:700; font-size:18px; letter-spacing:0.04em; }
    .addr { color:#6E6656; margin-top:6px; font-size:14px; }
    .hint { max-width:340px; margin:22px auto 0; color:#1A160F; font-size:14px; line-height:1.5; }
    .noprint button { margin-top:24px; padding:10px 16px; border:0; border-radius:4px; background:#1A160F; color:#fff; font-weight:700; cursor:pointer; }
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

// Barre d'onglets de section, masquée au-delà de 760px (voir .section-tabs
// dans ui.css) : sur mobile, les portails client/prestataire/welcomer
// empilent plusieurs cartes pleine hauteur (biens, suivi, missions,
// compta…) et il faut tout dérouler pour atteindre la dernière. Cette barre
// ancre chaque onglet à l'id de sa carte, défile en douceur au clic, et
// surligne l'onglet de la carte actuellement visible via IntersectionObserver.
// Idempotent : un second appel sur le même mountEl ne duplique pas la barre
// (utile car le code appelant peut repasser par son écran "connecté" après
// une reconnexion).
export function initSectionTabs(mountEl, sections) {
  if (!mountEl || !sections || !sections.length) return;
  if (mountEl.querySelector(':scope > .section-tabs')) return;
  const present = sections.filter(s => document.getElementById(s.id));
  if (present.length < 2) return;

  const bar = document.createElement('div');
  bar.className = 'section-tabs';
  bar.setAttribute('role', 'tablist');
  const links = present.map(({ id, label }) => {
    const a = document.createElement('a');
    a.href = `#${id}`;
    a.textContent = label;
    a.addEventListener('click', event => {
      event.preventDefault();
      const target = document.getElementById(id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    bar.appendChild(a);
    return a;
  });
  mountEl.insertBefore(bar, mountEl.firstChild);

  const setActive = id => {
    links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${id}`));
  };
  setActive(present[0].id);

  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) setActive(entry.target.id);
      });
    }, { rootMargin: '-40% 0px -50% 0px', threshold: 0 });
    present.forEach(({ id }) => observer.observe(document.getElementById(id)));
  }
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
