'use strict';

/**
 * Zebramoon, Cloud Functions.
 *
 * ⚠️ DÉPLOIEMENT REQUIS (voir functions/README.md) :
 *   - Firebase plan **Blaze** (les Functions ne tournent pas sur le plan gratuit)
 *   - `cd functions && npm install`
 *   - clés/secrets à définir (Stripe, webhooks), voir README
 *   - `firebase deploy --only functions`
 *
 * Ce fichier est livré prêt à déployer mais N'A PAS été exécuté/testé en live
 * (pas d'accès de déploiement ni de compte Stripe côté atelier). Les parties
 * paiement/intégrations sont des PLACEHOLDERS clairement marqués.
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const PDFDocument = require('pdfkit');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

const db = admin.firestore();
// Doit rester identique à TEAM_EMAIL (shared.js) et teamInbox() (firestore.rules).
// Déploiement en attente (Blaze), à aligner lors du basculement OVH.
const TEAM_EMAIL = 'w.wanecque@gmail.com';
const VAT_RATE_FALLBACK = 0.20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Taux de TVA courant (config back-office settings/pricing), sinon secours.
async function currentVatRate() {
  try {
    const snap = await db.doc('settings/pricing').get();
    const r = snap.exists ? Number(snap.data().vatRate) : NaN;
    return Number.isFinite(r) ? r : VAT_RATE_FALLBACK;
  } catch (e) {
    return VAT_RATE_FALLBACK;
  }
}

// Reconstruit les lignes HT d'une réservation (même logique que le front).
function bookingLineItems(b) {
  const price = Number(b.price) || 0;
  const prestation = Number(b.prestationPrice) || 0;
  const amenities = Number(b.amenitiesPrice) || 0;
  const travel = Number(b.travelFee) || 0;
  const extrasHT = Number(b.extrasHT) || 0;
  const kits = Math.max(0, price - prestation - amenities - extrasHT - travel);
  const items = [{ label: `Menage ${b.serviceType === 'deep' ? 'approfondi' : 'standard'}${b.hours ? ` - ${b.hours} h` : ''}`, amount: prestation }];
  if (kits) items.push({ label: 'Kits de bienvenue', amount: kits });
  if (amenities) items.push({ label: 'Amenities', amount: amenities });
  (b.extras || []).forEach((e) => items.push({ label: `${e.name || 'Supplement'}${e.qty > 1 ? ` x ${e.qty}` : ''}`, amount: (Number(e.priceHT) || 0) * (Number(e.qty) || 0) }));
  if (travel) items.push({ label: 'Frais de deplacement', amount: travel });
  return { items, totalHT: price };
}

// Génère le PDF du devis (Buffer) via pdfkit.
function buildDevisPdf(booking, client, vatRate) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { items, totalHT } = bookingLineItems(booking);
    const vat = Math.round(totalHT * vatRate);
    const ttc = totalHT + vat;
    const ref = `CF-${String(booking.id || '').slice(0, 6).toUpperCase()}`;

    doc.fontSize(22).fillColor('#E6007E').text('Zebramoon', { continued: false });
    doc.moveDown(0.2).fontSize(18).fillColor('#1A160F').text('DEVIS');
    doc.fontSize(10).fillColor('#555')
      .text(`N° ${ref}`)
      .text(`Date : ${new Date().toLocaleDateString('fr-FR')}`);
    doc.moveDown();
    doc.fontSize(11).fillColor('#1A160F')
      .text(`Client : ${(client && client.email) || ''}`)
      .text(`Logement : ${booking.propertyAddress || ''}${booking.surface ? `, ${booking.surface} m²` : ''}`);
    doc.moveDown();

    items.forEach((it) => {
      doc.fontSize(11).fillColor('#1A160F').text(it.label, { continued: true })
        .fillColor('#1A160F').text(`   ${it.amount} EUR HT`, { align: 'right' });
    });
    doc.moveDown();
    doc.fontSize(11).text(`Total HT : ${totalHT} EUR`);
    doc.text(`TVA (${Math.round(vatRate * 100)} %) : ${vat} EUR`);
    doc.fontSize(14).fillColor('#E6007E').text(`Total TTC : ${ttc} EUR`);
    doc.moveDown();
    doc.fontSize(8).fillColor('#888').text('Devis emis par Zebramoon. Valable 30 jours. Menage verifie par controle photo avant confirmation.');
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// 1) Devis PDF automatique par email à la création d'une réservation
//    (réutilise l'extension « Trigger Email » via la collection `mail`).
// ---------------------------------------------------------------------------
exports.sendDevisOnBooking = onDocumentCreated('bookings/{bookingId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const booking = { id: event.params.bookingId, ...snap.data() };

  let email = booking.clientEmail;
  if (!email && booking.clientId) {
    const u = await db.collection('users').doc(booking.clientId).get();
    email = u.exists ? u.data().email : null;
  }
  if (!email) { logger.warn('sendDevisOnBooking: pas d’email client', { bookingId: booking.id }); return; }

  try {
    const vatRate = await currentVatRate();
    const pdf = await buildDevisPdf(booking, { email }, vatRate);
    await db.collection('mail').add({
      to: email,
      message: {
        subject: `Zebramoon, votre devis ${String(booking.id).slice(0, 6).toUpperCase()}`,
        text: 'Bonjour,\n\nVeuillez trouver ci-joint le devis de votre réservation Zebramoon.\n\nL’équipe Zebramoon.',
        attachments: [{
          filename: `devis-${String(booking.id).slice(0, 6).toUpperCase()}.pdf`,
          content: pdf.toString('base64'),
          encoding: 'base64',
        }],
      },
    });
    // Copie équipe (notification).
    await db.collection('mail').add({
      to: TEAM_EMAIL,
      message: { subject: `Nouveau devis émis · ${booking.propertyAddress || ''}`, text: `Réf ${String(booking.id).slice(0, 6).toUpperCase()} · ${email} · ${booking.price} € HT` },
    });
  } catch (e) {
    logger.error('sendDevisOnBooking a échoué', e);
  }
});

// ---------------------------------------------------------------------------
// 2) CRM : crée une fiche prospect à partir d'une demande de devis (>250 m²).
//    Alimente automatiquement l'onglet Prospects du back-office.
// ---------------------------------------------------------------------------
exports.prospectFromDevisRequest = onDocumentCreated('messages/{messageId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const m = snap.data();
  if (!m || !/devis/i.test(m.text || '')) return; // seulement les demandes de devis
  try {
    await db.collection('prospects').add({
      name: m.clientName || '',
      email: m.clientEmail || '',
      phone: '',
      address: m.propertyAddress || '',
      montant: 0,
      source: 'Demande de devis (site)',
      note: m.text || '',
      status: 'Nouveau',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.error('prospectFromDevisRequest a échoué', e);
  }
});

// ---------------------------------------------------------------------------
// 3) API REST (squelette). Lecture d'indicateurs, protégée par clé API.
//    Base pour les futures connexions (Airbnb, Booking, etc.).
//    ⚠️ Placeholder : définir process.env.API_KEY avant usage réel.
// ---------------------------------------------------------------------------
exports.api = onRequest(async (req, res) => {
  const key = req.get('x-api-key');
  if (!process.env.API_KEY || key !== process.env.API_KEY) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.path === '/stats' && req.method === 'GET') {
    const bookings = await db.collection('bookings').get();
    let ca = 0; let nb = 0;
    bookings.forEach((d) => { const b = d.data(); if (b.status !== 'cancelled') { ca += Number(b.price) || 0; nb += 1; } });
    res.json({ reservations: nb, caPotentielHT: ca });
    return;
  }
  res.status(404).json({ error: 'not_found' });
});

// ---------------------------------------------------------------------------
// 4) PAIEMENT, PLACEHOLDER Stripe.
//    Aucun compte Stripe n'existe encore. Cette fonction renvoie une erreur
//    tant que la clé n'est pas configurée. Décommenter et compléter une fois
//    le compte créé et `STRIPE_SECRET` défini (voir README).
// ---------------------------------------------------------------------------
exports.createCheckoutSession = onCall(async (request) => {
  if (!process.env.STRIPE_SECRET) {
    throw new HttpsError('failed-precondition', 'Paiement non configuré (Stripe à venir).');
  }
  // --- À COMPLÉTER quand le compte Stripe existe : ---
  // const stripe = require('stripe')(process.env.STRIPE_SECRET);
  // const bookingId = request.data.bookingId;
  // const booking = (await db.collection('bookings').doc(bookingId).get()).data();
  // const session = await stripe.checkout.sessions.create({ ...lignes, mode:'payment', success_url, cancel_url });
  // return { url: session.url };
  throw new HttpsError('unimplemented', 'À implémenter avec le compte Stripe.');
});

// ---------------------------------------------------------------------------
// 5) Intégrations (Make / Zapier / HubSpot / Pennylane), PLACEHOLDER.
//    Poste un événement vers un webhook si l'URL est configurée ; sinon no-op.
//    Ex. : définir INTEGRATIONS_WEBHOOK pour relayer chaque nouveau prospect.
// ---------------------------------------------------------------------------
async function notifyIntegrations(kind, payload) {
  const url = process.env.INTEGRATIONS_WEBHOOK;
  if (!url) return; // aucune intégration configurée
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, payload }) });
  } catch (e) {
    logger.warn('notifyIntegrations: envoi échoué', e);
  }
}

exports.relayNewProspect = onDocumentCreated('prospects/{id}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  await notifyIntegrations('prospect.created', { id: event.params.id, ...snap.data() });
});
