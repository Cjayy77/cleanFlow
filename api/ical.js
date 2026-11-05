// Zebramoon, proxy de calendriers iCal (Airbnb, Booking, Google Agenda…).
// Le navigateur ne peut pas lire ces flux directement (pas d'en-tête CORS) :
// cette fonction Vercel les télécharge pour un utilisateur connecté et
// renvoie le texte .ics tel quel. Elle refuse tout ce qui n'est pas un
// lien https public (pas d'adresse interne, taille et durée bornées).
const dns = require('dns').promises;
const net = require('net');

// Clé web Firebase : publique par conception (même valeur que firebase-config.js).
const FIREBASE_API_KEY = 'AIzaSyD_sfy0LLSG8-_3BNoXzjdx48bv7a6htmU';
const MAX_BYTES = 1500000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return isBlockedAddress(v.slice(7));
    return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
  }
  return true;
}

function normalizeFeedUrl(raw) {
  let value = String(raw || '').trim();
  if (/^webcal:\/\//i.test(value)) value = `https://${value.slice(9)}`;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return url;
}

async function assertPublicHost(url) {
  if (net.isIP(url.hostname)) {
    if (isBlockedAddress(url.hostname)) throw new Error('blocked');
    return;
  }
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length || records.some(r => isBlockedAddress(r.address))) throw new Error('blocked');
}

async function download(url, depth = 0) {
  await assertPublicHost(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'manual', signal: ctrl.signal, headers: { Accept: 'text/calendar, text/plain, */*', 'User-Agent': 'Zebramoon-Calendar/1.0' } });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (depth >= MAX_REDIRECTS) throw new Error('redirects');
      const next = normalizeFeedUrl(new URL(res.headers.get('location') || '', url).toString());
      if (!next) throw new Error('blocked');
      return download(next, depth + 1);
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error('too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('too large');
    return buf.toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

async function verifyFirebaseUser(idToken) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return !!(data && data.users && data.users[0]);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !(await verifyFirebaseUser(token).catch(() => false))) {
    res.status(401).json({ error: 'Connexion requise' });
    return;
  }
  const url = normalizeFeedUrl(req.query && req.query.url);
  if (!url) { res.status(400).json({ error: 'Le lien du calendrier doit commencer par https:// ou webcal://' }); return; }
  try {
    const text = await download(url);
    if (!/BEGIN:VCALENDAR/i.test(text)) { res.status(422).json({ error: 'Ce lien ne renvoie pas un calendrier iCal (.ics).' }); return; }
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.status(200).send(text);
  } catch (e) {
    const msg = e && e.message === 'blocked' ? 'Adresse non autorisée.' : 'Impossible de lire ce calendrier pour le moment.';
    res.status(502).json({ error: msg });
  }
}

module.exports = handler;
module.exports.isBlockedAddress = isBlockedAddress;
module.exports.normalizeFeedUrl = normalizeFeedUrl;
