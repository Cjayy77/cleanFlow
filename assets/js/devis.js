// Zebramoon, devis en ligne public (sans compte). Auth anonyme pour lire les
// tarifs/catalogue et enregistrer le prospect.
import {
  auth,
  db,
  computeBookingPrice,
  setPricing,
  getPricing,
  openDevisDocument,
  queueEmail,
  TEAM_EMAIL,
  authErrorMessage,
  withButtonLoading,
  withTimeout,
} from './shared.js';
import { signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { doc, getDoc, collection, getDocs, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const $ = id => document.getElementById(id);
const STEP_COUNT = 5; // 0..4 (4 = résultat)
let currentStep = 0;
let catalog = [];
let selectedExtras = {};
let authOk = false;

const wizardStatus = $('wizardStatus');
function setStatus(msg, type) {
  if (!wizardStatus) return;
  wizardStatus.textContent = msg;
  wizardStatus.className = `status-banner ${type || ''}`.trim();
  wizardStatus.classList.toggle('hidden', !msg);
}

// --- Chargement (auth anonyme + config + catalogue) ---
(async function init() {
  try {
    await signInAnonymously(auth);
    authOk = true;
  } catch (e) {
    // Sans auth anonyme (provider non activé) : le devis se calcule quand même
    // avec les tarifs par défaut, mais l'envoi du lead sera indisponible.
    authOk = false;
  }
  if (authOk) {
    try {
      const snap = await getDoc(doc(db, 'settings', 'pricing'));
      if (snap.exists()) setPricing(snap.data());
    } catch (e) { /* défauts */ }
    try {
      const cat = await getDocs(collection(db, 'catalog'));
      catalog = cat.docs.map(d => ({ id: d.id, ...d.data() })).filter(i => i.active !== false);
    } catch (e) { catalog = []; }
  }
  renderSupplements();
  const P = getPricing();
  if (P.taxCreditEnabled === false) $('wTaxCreditWrap').classList.add('hidden');
})();

// --- Navigation ---
function showStep(n) {
  currentStep = Math.max(0, Math.min(STEP_COUNT - 1, n));
  document.querySelectorAll('.wizard-step').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.step) === currentStep);
  });
  document.querySelectorAll('.step-chip').forEach(el => {
    const s = Number(el.dataset.step);
    el.classList.toggle('active', s === currentStep);
    el.classList.toggle('done', s < currentStep);
  });
  $('wPrev').style.visibility = currentStep === 0 ? 'hidden' : 'visible';
  $('wNext').classList.toggle('hidden', currentStep >= STEP_COUNT - 1);
  if (currentStep === STEP_COUNT - 1) renderResult();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function validateStep(n) {
  if (n === 0) {
    if (!$('wPrenom').value.trim() || !$('wNom').value.trim() || !$('wEmail').value.trim()) {
      setStatus('Renseignez au moins prénom, nom et email.', 'error'); return false;
    }
  }
  if (n === 1) {
    if (!(Number($('wSurface').value) > 0)) { setStatus('Indiquez la surface du logement.', 'error'); return false; }
  }
  setStatus('', '');
  return true;
}

$('wNext').addEventListener('click', () => { if (validateStep(currentStep)) showStep(currentStep + 1); });
$('wPrev').addEventListener('click', () => showStep(currentStep - 1));
document.querySelectorAll('.step-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const target = Number(chip.dataset.step);
    if (target <= currentStep || validateStep(currentStep)) showStep(target);
  });
});

// --- Lecture des saisies ---
function logement() {
  return {
    surface: Number($('wSurface').value) || 0,
    beds: Math.max(1, Math.floor(Number($('wBeds').value) || 1)),
    bathrooms: Math.max(1, Math.floor(Number($('wBathrooms').value) || 1)),
    bedrooms: Math.max(0, Math.floor(Number($('wBedrooms').value) || 0)),
    guests: Math.max(0, Math.floor(Number($('wGuests').value) || 0)),
    type: $('wType').value,
    service: (document.querySelector('input[name="wService"]:checked') || {}).value || 'normal',
  };
}

function selectedExtrasList() {
  return catalog
    .filter(i => (selectedExtras[i.id] || 0) > 0)
    .map(i => {
      const qty = selectedExtras[i.id];
      const priceHT = Number(i.priceHT) || 0;
      return { id: i.id, name: i.name || '', type: i.type || '', priceHT, priceTTC: Number(i.priceTTC) || 0, qty, lineHT: priceHT * qty };
    });
}

// --- Suppléments (catalogue) ---
const LABELS = { service: 'Prestations', kit: "Kits d'accueil", consumable: 'Consommables', linen: 'Location de linge' };
function renderSupplements() {
  const host = $('wSupplements');
  if (!host) return;
  host.innerHTML = '';
  if (!catalog.length) return;
  const l = logement();
  ['service', 'kit', 'consumable', 'linen'].forEach(type => {
    const items = catalog.filter(i => i.type === type).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!items.length) return;
    const head = document.createElement('div');
    head.className = 'p-meta';
    head.style.cssText = 'text-transform:uppercase;letter-spacing:0.06em;margin:14px 0 2px;';
    head.textContent = LABELS[type] || type;
    host.appendChild(head);
    items.forEach(item => {
      const auto = item.unit === 'bed' || item.unit === 'guest';
      const basis = item.unit === 'bed' ? l.beds : l.guests;
      const row = document.createElement('div');
      row.className = 'chk-row';
      if (auto) {
        const cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = (selectedExtras[item.id] || 0) > 0;
        cb.onchange = () => { if (cb.checked && basis > 0) selectedExtras[item.id] = basis; else delete selectedExtras[item.id]; };
        const span = document.createElement('span');
        span.textContent = `${item.name}, ${item.priceTTC || 0}€ TTC × ${basis} ${item.unit === 'bed' ? 'lit(s)' : 'voyageur(s)'}`;
        row.append(cb, span);
      } else {
        const span = document.createElement('span');
        span.style.flex = '1';
        span.textContent = `${item.name}, ${item.priceTTC || 0}€ TTC / unité`;
        const qty = document.createElement('input');
        qty.type = 'number'; qty.min = '0'; qty.step = '1'; qty.value = selectedExtras[item.id] || 0;
        qty.style.cssText = 'width:70px;text-align:center;';
        qty.oninput = () => { const n = Math.max(0, Math.floor(Number(qty.value) || 0)); if (n > 0) selectedExtras[item.id] = n; else delete selectedExtras[item.id]; };
        row.append(span, qty);
      }
      host.appendChild(row);
    });
  });
}

// --- Calcul & rendu du résultat ---
function computeAll() {
  const l = logement();
  const quote = computeBookingPrice({ surface: l.surface, serviceType: l.service, beds: l.beds, bathrooms: l.bathrooms, bedrooms: l.bedrooms, zone: '' });
  const extras = selectedExtrasList();
  const extrasHT = extras.reduce((s, e) => s + e.lineHT, 0);
  return { l, quote, extras, extrasHT };
}

function pseudoBooking(l, quote, extras, extrasHT, finalHT) {
  return {
    id: 'DEVIS' + Date.now().toString(36),
    propertyAddress: `${$('wAddress').value.trim()}${$('wCity').value.trim() ? ', ' + $('wCity').value.trim() : ''}`,
    surface: l.surface, hours: quote.hours, serviceType: quote.serviceType,
    prestationPrice: quote.prestation, amenitiesPrice: 0, travelFee: quote.travel,
    commission: quote.commission, extras: extras.map(e => ({ name: e.name, priceHT: e.priceHT, qty: e.qty })),
    extrasHT, bedrooms: quote.bedrooms, kitCount: quote.kitCount, price: finalHT, scheduledDate: '',
  };
}

function renderResult() {
  renderSupplements();
  const { l, quote, extras, extrasHT } = computeAll();
  const breakdown = $('wBreakdown');
  const P = getPricing();

  if (!quote) { breakdown.innerHTML = '<div class="pb-line pb-warn"><span>Indiquez la surface pour calculer.</span><b></b></div>'; $('wTotal').textContent = ', '; return; }
  if (quote.custom) {
    breakdown.innerHTML = '<div class="pb-line pb-warn"><span>Surface > 250 m² : devis sur-mesure. Envoyez votre demande, l\'équipe vous recontacte.</span><b></b></div>';
    $('wTotal').textContent = 'Sur devis'; $('wTaxCreditBox').innerHTML = ''; $('wSavings').innerHTML = '';
    return;
  }

  const finalHT = quote.total + extrasHT;
  const vat = Math.round(finalHT * quote.vatRate);
  const ttc = finalHT + vat;

  const rows = [[`Ménage ${quote.serviceType === 'deep' ? 'approfondi' : 'standard'} · ${String(quote.hours).replace('.', ',')} h × ${quote.hourlyRate}€/h`, quote.prestation]];
  if (quote.kitCount > 0) rows.push([`Kits de bienvenue · ${quote.kitCount} chambre${quote.kitCount > 1 ? 's' : ''}`, quote.kitsTotal]);
  extras.forEach(e => rows.push([`${e.name}${e.qty > 1 ? ` × ${e.qty}` : ''}`, e.lineHT]));
  if (quote.commission) rows.push(['Commission Zebramoon', quote.commission]);
  if (quote.travel) rows.push(['Frais de déplacement', quote.travel]);
  rows.push(['Total HT', finalHT, 'pb-total']);
  rows.push([`TVA (${Math.round(quote.vatRate * 100)} %)`, vat]);
  breakdown.innerHTML = rows.map(r => `<div class="pb-line ${r[2] || ''}"><span></span><b>${r[1]}&nbsp;€</b></div>`).join('');
  breakdown.querySelectorAll('.pb-line span').forEach((s, i) => { s.textContent = rows[i][0]; });
  $('wTotal').textContent = `${ttc}€`;

  // Crédit d'impôt : 50 % (paramétrable) de la main-d'œuvre éligible (le ménage).
  const tcBox = $('wTaxCreditBox');
  const eligible = P.taxCreditEnabled !== false && $('wTaxCredit').checked;
  if (eligible) {
    const labor = quote.prestation; // main-d'œuvre ménage (hors kits/commission/déplacement/suppléments)
    const credit = Math.round(labor * (P.taxCreditRate || 0.5));
    const reste = ttc - credit;
    tcBox.innerHTML = `<div class="tc-box">
      <div class="eyebrow">Crédit d'impôt « Services à la Personne »</div>
      <div class="pb-line"><span>Main-d'œuvre éligible</span><b>${labor}&nbsp;€</b></div>
      <div class="pb-line"><span>Crédit d'impôt estimé (${Math.round((P.taxCreditRate || 0.5) * 100)} %)</span><b>− ${credit}&nbsp;€</b></div>
      <div class="pb-line pb-total"><span>Reste à charge estimatif</span><b>${reste}&nbsp;€</b></div>
      <div class="note-box">Estimation indicative sous réserve des conditions légales. Kits, consommables, linge, commission et abonnement ne sont pas éligibles.</div>
    </div>`;
  } else {
    tcBox.innerHTML = '';
  }

  // Comparateur d'économies (facultatif, depuis l'étape 3).
  const night = Number($('wNight').value) || 0;
  const occ = Math.min(100, Number($('wOcc').value) || 0);
  const monthly = Number($('wMonthly').value) || 0;
  const sav = $('wSavings');
  if (night > 0 && monthly > 0) {
    const nights = Math.round(365 * occ / 100);
    const revenue = night * nights;
    const conciergerie = Math.round(revenue * 0.22);
    const cleanflowAnnual = monthly * 12 * (quote.prestation + quote.commission) + 12 * (P.subscriptionMonthly || 0);
    const economie = conciergerie - cleanflowAnnual;
    const pct = conciergerie > 0 ? Math.round(economie / conciergerie * 100) : 0;
    sav.innerHTML = `<div class="eyebrow">Vos économies estimées / an</div>
      <div class="stat-grid">
        <div class="stat"><b>${revenue.toLocaleString('fr-FR')}€</b><span>Revenus locatifs</span></div>
        <div class="stat"><b>${conciergerie.toLocaleString('fr-FR')}€</b><span>Conciergerie classique</span></div>
        <div class="stat"><b>${cleanflowAnnual.toLocaleString('fr-FR')}€</b><span>Avec Zebramoon</span></div>
        <div class="stat"><b>${economie > 0 ? economie.toLocaleString('fr-FR') + '€' : ', '}</b><span>${economie > 0 ? `Économie (${pct} %)` : 'Avantage croissant'}</span></div>
      </div>
      <div class="note-box">Hypothèse : commission conciergerie 22 %. Estimation indicative.</div>`;
  } else {
    sav.innerHTML = '';
  }

  // PDF
  $('wPdfBtn').onclick = () => {
    const b = pseudoBooking(l, quote, extras, extrasHT, finalHT);
    openDevisDocument(b, { name: `${$('wPrenom').value.trim()} ${$('wNom').value.trim()}`.trim(), email: $('wEmail').value.trim() });
  };
}

// --- Envoi du prospect ---
$('wSubmitBtn').addEventListener('click', async () => {
  const { l, quote, extras, extrasHT } = computeAll();
  const name = `${$('wPrenom').value.trim()} ${$('wNom').value.trim()}`.trim();
  const email = $('wEmail').value.trim();
  if (!name || !email) { setStatus('Prénom, nom et email sont nécessaires pour envoyer.', 'error'); showStep(0); return; }
  let ttc = 0;
  if (quote && !quote.custom) { const fh = quote.total + extrasHT; ttc = fh + Math.round(fh * quote.vatRate); }
  const address = `${$('wAddress').value.trim()}${$('wCity').value.trim() ? ', ' + $('wCity').value.trim() : ''} ${$('wPostal').value.trim()}`.trim();
  const note = `Devis en ligne, ${l.type}, ${l.surface} m², ${l.beds} lit(s), ${l.bathrooms} sdb, ${l.bedrooms} chambre(s), ${l.guests} voyageur(s). Service ${l.service}. ${extras.length ? 'Suppléments : ' + extras.map(e => `${e.name}×${e.qty}`).join(', ') + '.' : ''} Total ${ttc || 'sur devis'}€ TTC.`;

  if (!authOk) {
    setStatus('Envoi indisponible pour le moment. Écrivez-nous à ' + TEAM_EMAIL + ', votre devis reste téléchargeable en PDF.', 'error');
    return;
  }
  try {
    await withButtonLoading($('wSubmitBtn'), () => withTimeout(addDoc(collection(db, 'prospects'), {
      name, email, phone: $('wPhone').value.trim(), address,
      montant: ttc, source: 'Devis en ligne', note, status: 'Nouveau', createdAt: serverTimestamp(),
    }), 15000));
    queueEmail({
      to: TEAM_EMAIL,
      subject: `Zebramoon, nouveau devis en ligne · ${name}`,
      text: `${name} · ${email} · ${$('wPhone').value.trim()}\n${address}\n${note}`,
    });
    setStatus('Merci ! Votre demande est envoyée. L\'équipe Zebramoon vous recontacte rapidement.', 'success');
    $('wSubmitBtn').disabled = true;
  } catch (err) {
    setStatus(`Envoi impossible : ${authErrorMessage(err)}`, 'error');
  }
});

showStep(0);
