# CleanFlow — Technical Documentation & Scope of Work

Reference document describing the entire CleanFlow platform: every page, its
logic, its rules, the data model, and the infrastructure. Intended as the basis
for invoicing (deliverables summary in Section 10).

---

## 1. Overview

CleanFlow is a web platform for **verified cleaning of short-term rentals**. Its
defining feature: every job is documented with a mandatory set of photos,
**reviewed by a human (the CleanFlow team) before any confirmation is sent to
the client**. Nothing is validated automatically. On top of the operations core,
the platform now includes a full **automatic quote engine** (public, with a
self-service back-office) and an on-site **quality-control (Welcomer) system**.

Five roles, five distinct interfaces:

| Role | Who | Access |
|---|---|---|
| **Client** | Rental property owner | Free self sign-up |
| **Prestataire** (cleaner) | Partner cleaning company | On approved request |
| **Livreur** (delivery) | Linen / kit delivery service | On approved request |
| **Welcomer** (on-site QC) | Independent quality-control partner | On approved request |
| **Admin** | CleanFlow team (review + operations) | On approved request |

Plus a **public quote wizard** (`/devis/`) usable without an account (anonymous
authentication), which feeds the CRM.

---

## 2. Technical stack & architecture

- **Static site** — no framework, no build step. HTML + CSS + JavaScript (ES
  modules) served as-is.
- **Firebase backend** (managed, no server to run):
  - **Authentication** — email / password login **+ anonymous auth** (public
    quote wizard).
  - **Firestore** — real-time database (live listeners via `onSnapshot`),
    including a **live pricing configuration** document editable from the admin
    back-office.
  - **Storage** — job, incident, catalog and Welcomer photos.
- **Firebase SDK 10.12.2** loaded from the Google CDN (ES modules), no bundler.
- **Cloud Functions scaffold** (`functions/`, Node 20) — devis PDF email,
  prospect relay, REST API skeleton, Stripe placeholder, integration webhook.
  Deploy-pending (requires Blaze billing + provider keys).
- **Vendored QR generator** (`assets/js/vendor/qrcode.js`, MIT) — property QR
  codes generated fully client-side, no external request.
- **Vercel hosting** — auto-deploy on every push, static site.
- **Email notifications** — official *Trigger Email from Firestore* extension
  consuming a `mail` collection (no mail server to code).
- **Shared data layer**: `assets/js/shared.js` centralises Firebase access,
  role constants, the **pricing engine** (config + calculations), the printable
  devis/receipt generator, the QR helpers, and utilities shared by every
  interface.
- **Single stylesheet**: `assets/ui.css` (common design system).
- **Server-side security**: `firestore.rules` + `storage.rules` enforce role
  separation and every allowed transition — security never depends on the UI.

---

## 3. Site map (routes)

```
/                     Public marketing site (landing)
/devis/               Public automatic quote wizard (no account required)
/app/                 Client portal
/prestataire/         Cleaner interface
/livreur/             Delivery interface
/welcomer/            Welcomer (on-site quality control) interface
/admin/               CleanFlow admin console + back-office
/legal/cgu.html       Terms of use
/legal/confidentialite.html   Privacy policy
```

Supporting files:

```
assets/js/shared.js       Data layer + pricing engine + devis/QR + shared logic
assets/js/devis.js        Public quote wizard logic
assets/js/app.js          Client portal logic
assets/js/prestataire.js  Cleaner logic
assets/js/livreur.js      Delivery logic
assets/js/welcomer.js     Welcomer logic (QC + QR scan)
assets/js/admin.js        Admin console + back-office logic
assets/js/vendor/qrcode.js  Vendored QR generator (MIT)
assets/ui.css             Shared design system
firebase-config.js        Firebase project configuration
firestore.rules           Database security rules
storage.rules             Photo storage security rules
functions/                Cloud Functions scaffold (deploy-pending)
firebase.json / .firebaserc   Functions/hosting config
vercel.json               Hosting configuration
SETUP.md                  Setup guide (100% browser-based)
```

---

## 4. Page-by-page description

### 4.1 — Public landing (`/`)

Responsive marketing page, single narrative column, **no prices shown** (the
price grid is members-only, visible after sign-up).

**Sections:** sticky nav + CTA, hero (value proposition + animated "verified"
stamp), roles, 5-step process, human-verification band, pricing (described
without amounts), services, FAQ, beta band, final CTA + contact, multi-column
footer.

**Logic / animations:** scroll reveals via IntersectionObserver (disabled under
`prefers-reduced-motion`), hero entrance, rotating stamp. Poppins display type.
No Firebase data on this page (public).

### 4.2 — Public quote wizard (`/devis/`)

Instant automatic quote, **usable without an account** (anonymous Firebase
auth). Four steps + result:

- **Step 1 — Client:** first name, name, phone, email, full address, city,
  postcode.
- **Step 2 — Property:** type (studio / apartment / house), surface (m²),
  bedrooms, bathrooms, beds, max guests.
- **Step 3 — Rental activity:** bookings per month, average nightly price,
  occupancy rate (used by the savings comparator).
- **Step 4 — Services:** standard / deep cleaning + selectable supplements
  pulled live from the catalog (services, kits, consumables, linen), with
  per-unit / per-bed / per-guest quantities.
- **Live quote:** cleaning HT (hours × hourly rate), commission, kits /
  consumables / linen, application subscription, **VAT**, **Total HT**, **Total
  TTC** — recomputed as fields change. Above 250 m² → custom-quote message.
- **Crédit d'impôt (Services à la Personne):** toggleable; when eligible, shows
  eligible labour, the estimated 50 % tax credit, and the estimated net cost —
  excluding subscription, commission, kits, consumables, linen and supplies from
  the base.
- **Savings comparator:** estimated rental income, a classic concierge's
  commission, the annual cost with CleanFlow, and the resulting annual saving.
- **PDF devis:** printable quote (see 7.x) generated client-side.
- **Submit:** creates a **CRM prospect** (source "Devis en ligne", status
  "Nouveau") and notifies the team.

### 4.3 — Client portal (`/app/`)

**Auth:** email/password sign-in, **free client registration**, "Forgot
password?".

**Application:**
- **Welcome banner** — contextual by progress + beta note.
- **Your properties** — CRUD (address, city, postcode, surface, zone, access
  notes); delete blocked while a booking is active; address edits propagate to
  active bookings.
- **Booking** — for the selected property: property type, service type
  (standard / deep), **bedrooms / bathrooms / beds / guests** (drive the hourly
  estimate and the number of welcome kits), **supplement selection** from the
  catalog, optional **Welcomer on-site control**, monthly calendar, and a **live
  price breakdown in HT → VAT → TTC** shown before confirming. Above 250 m² →
  "Request a quote".
- **Your bookings** — history with a 4-step tracker, cancel (while `pending`),
  **1–5 star rating** once verified, "Contact the team", and a **Devis / receipt
  (PDF)** button per active booking.

### 4.4 — Cleaner interface (`/prestataire/`)

**Auth:** sign-in + access request (`pending` until approved); suspended-account
message.

**Application:** assigned missions only (no self-serve pool); photo dossier
upload (slot grid, timeouts, error handling); submit for verification; decline
(two-click); report an incident; **My ratings**.

### 4.5 — Delivery interface (`/livreur/`)

**Auth:** same as cleaner. **Application:** assigned linen/kit tours only
(`livreurId`) — address, date, reference, mark done / undo.

### 4.6 — Welcomer interface (`/welcomer/`)

Independent partner who performs the **on-site quality control** after the
cleaner and before the guest arrives.

**Auth:** sign-in + access request (same lifecycle as the other team roles).

**Application:**
- **Scan the property** — three ways to open the right control on arrival:
  (1) the phone's **native camera** on the property QR opens a deep link that
  auto-loads the mission; (2) an **in-app scanner** (BarcodeDetector, feature-
  detected); (3) **manual reference** entry. All match against the Welcomer's
  assigned missions only.
- **My controls** — assigned QC missions.
- **On-site validation form:** mandatory **checklist** (cleaning, linen,
  consumables, equipment, ambiance), **timestamped photos** (uploaded to
  Storage), **digital signature** (canvas), **conformity level**:
  - *Level 1 — conforme* → booking **verified**, owner notified.
  - *Level 2 — to fix* / *Level 3 — non-conforme* → booking **rejected**
    (returned / penalty), owner and team notified.
  - free note. The validation is sent automatically to the team/owner.
- **Billable tiers** (configurable): validation 15 €, + photos 20 €, + guest
  welcome 35 €, + inventory (état des lieux) 45 €.

### 4.7 — Admin console + back-office (`/admin/`)

The richest interface. Tabs (sticky bar, real-time action badges).

**Tabs:**

- **To assign** *(badge)* — *Missions* (cleaner dropdown **ranked by rating,
  Premium status and load**), *Deliveries* (delivery ranked by load), and
  ***Welcomer controls*** (welcomer ranked by load, with a **"Property QR"
  print button** to place at the logement). Assigning emails the worker.
- **Calendar** — overview metrics + colour-coded monthly calendar, ≤ 3-day
  urgencies flagged red, day panel with assign / verify / cancel / reschedule.
- **Verification** *(badge)* — dossier queue, photo grid, mandatory rejection
  note, approve / return.
- **Messages** *(badge)* — client messages + open incidents.
- **Team** *(badge)* — roster of **Cleaners / Delivery / Welcomers**: member
  cards (modal), load, cleaner **rating**, **Welcomer validation rate + "★
  Prestataire Premium" badge**, suspend / reactivate; access requests
  (approve / reject).
- **Accounting (Compta)** — **time-frame filters** (week / month / year / all /
  custom) + filter by cleaner / property; mission ledger with **per-mission
  cost breakdown** (HT / VAT / TTC, supplements, commission), discretionary
  bonus / malus, net.
- **Prospects (CRM)** — fiche list (identity, contact, property, quote amount,
  source, date), **statuses** Nouveau / À rappeler / En attente / Client /
  Perdu, full CRUD; auto-fed by the public quote wizard.
- **Catalog** — CRUD for **services, kits, consumables, linen**: name, photo
  (upload), description, price HT, price TTC (auto from HT), and category +
  stock for consumables; **unit** per-unit / per-bed / per-guest.
- **Pricing back-office (Tarifs)** — **edit every pricing parameter without a
  developer**: standard/deep hourly rates, the surface × beds time grid, extra
  hours per bed / per bathroom / per 25 m² above the top band, applied
  commission (min/max), monthly subscription, VAT rate, tax-credit rate +
  on/off, custom devis footer text, and served cities. Applied live via a
  Firestore config document with a defensive fallback.
- **Dashboard** — KPIs: quotes / prospects, potential revenue, signed revenue,
  average basket, active clients, monthly & yearly revenue, conversion rate,
  number of services.

### 4.8 — Legal pages (`/legal/`)

Terms of use (service, beta, accounts, booking & pricing, workflow, photos +
90-day retention, incidents, liability, IP, law) and privacy policy.

---

## 5. Data model (Firestore)

- **`users/{uid}`** — `uid`, `role` (client / prestataire / livreur / welcomer /
  admin), `accountStatus` (pending / approved / rejected / suspended), `name`,
  `email`, `phone`, `inviteCode`, `createdAt`.
- **`properties/{id}`** — `ownerId`, `street`, `city`, `postalCode`, `surface`,
  `zone`, `notes`, `createdAt`.
- **`bookings/{id}`** — `clientId`, `propertyId`, `propertyAddress`,
  `prestataireId`, `livreurId`, `welcomerId`, `serviceType`, `surface`, `zone`,
  `propertyType`, `beds`, `bathrooms`, `guests`, `bedrooms`, `hours`,
  `kitCount`, `linenRequested`, `prestationPrice`, `amenitiesPrice`, `travelFee`,
  `commission`, `extras[]`, `extrasHT`, `welcomerService`, `welcomerFee`,
  `price` (total HT), `scheduledDate`, `status`, `createdAt`; then over the
  lifecycle: `adminNote`, `verifiedBy`, `verifiedAt`, `rating`, `ratedAt`,
  `linenDone`, `adjustment`, `adjustmentNote`, and the Welcomer verdict
  `welcomerLevel`, `welcomerChecklist`, `welcomerPhotos`, `welcomerSignature`,
  `welcomerNote`, `validatedAt`.
- **`settings/pricing`** — the **live pricing configuration** (hourly rates,
  time grid, per-extra-bed/bath hours, per-25 m² rule, max auto surface, kit
  price, travel fee, commission min/max, monthly subscription, VAT rate,
  tax-credit rate + flag, devis footer text, cities). Editable from the
  back-office.
- **`catalog/{id}`** — `type` (service / kit / consumable / linen), `name`,
  `description`, `priceHT`, `priceTTC`, `category`, `stock`, `unit`, `imageUrl`.
- **`prospects/{id}`** — `name`, `email`, `phone`, `address`, `montant`,
  `source`, `status`, `note`, `createdAt`.
- **`photos/{id}`**, **`incidents/{id}`**, **`messages/{id}`**, **`mail/{id}`**
  — as before (dossier photos, incident reports, client→team messages, email
  extension queue).

**Booking lifecycle:** `pending` → (admin assigns) `accepted` → (photos)
`submitted` → `verified` / `rejected`. A Welcomer control can drive
`verified` (level 1) or `rejected` (level 2/3). `cancelled` at the allowed
stages. A cleaner can **decline** back to `pending`.

---

## 6. Security rules (server-side)

All authorisation is **proven server-side**. A role is effective only if
`accountStatus == approved`.

**`firestore.rules` — key points:**
- *users* — self-read, admin list, constrained creation (client → approved;
  prestataire / livreur / **welcomer** / admin → pending), admin status
  changes incl. **suspended**.
- *properties* — owner read/write (+ admin read).
- *bookings* — partitioned reads (client, assigned cleaner, assigned delivery,
  **assigned Welcomer**, admin); client creation with a **validated field
  whitelist** (all pricing/property/welcomer fields); strictly bounded
  transitions: client cancel & rating, cleaner submit/decline, delivery
  `linenDone`, admin assign-cleaner / assign-delivery / **assign-welcomer** /
  verdict / cancel / reschedule / bonus-malus, and **Welcomer validation**
  (status verified/rejected + level 1–3 + checklist/photos/signature/note).
- *settings* & *catalog* — read if signed-in, write if admin.
- *prospects* — admin read/update/delete; create if admin **or** (signed-in +
  status "Nouveau" + validated fields) so the public wizard can file a lead.
- *mail* — recipient restricted to a single `teamInbox()` helper (or any
  address for admin); never readable client-side.
- *messages* / *incidents* — client / cleaner create, admin read/close.

**`storage.rules`** — role checked **via Firestore**: dossier photos (admin /
assigned cleaner / owning client read; assigned cleaner write); incidents;
**catalog** (signed-in read, admin write); **Welcomer photos** (assigned
Welcomer write; admin / owning client / assigned Welcomer read); size + image
type limits everywhere.

---

## 7. Cross-cutting features

1. **Automatic quote engine** — hourly model (standard 30 € / deep 50 € HT per
   hour) × a **time grid** (surface bands × beds, + hours per extra bed /
   bathroom, + per 25 m² above the top band, custom quote > 250 m²); commission
   (4–12 € HT, applied), monthly application subscription (10 € HT), **VAT
   pass-through (HT / VAT / TTC)**. **Single source of truth in `shared.js`**,
   entirely **admin-configurable** via the back-office (live config +
   defensive normalisation).
2. **Catalog & supplements** — services, kits, consumables (category + stock),
   and linen, each with photos and HT/TTC; billed per-unit / per-bed /
   per-guest; selectable by client and in the public wizard.
3. **Crédit d'impôt** — Services-à-la-Personne handling: eligible labour, 50 %
   estimate, estimated net, with the correct exclusions; on/off per config.
4. **Savings comparator** — rental income vs. classic concierge commission vs.
   CleanFlow annual cost → annual saving.
5. **Devis / receipt PDF** — printable, client-side document (logo, quote
   number, date, 30-day validity, client & property, itemised HT lines, Total
   HT / VAT / TTC, editable footer / general terms). Available in the wizard and
   per booking in the client portal.
6. **CRM** — every online quote generates a prospect (identity, contact,
   property, amount, status, source, date) with a status pipeline; managed from
   the admin console; dashboard KPIs on top.
7. **Welcomer quality-control system** — on-site validation (checklist,
   timestamped photos, digital signature), conformity levels 1/2/3 driving the
   booking verdict, automatic owner notification, **billable tiers**, and a
   **quality score / validation rate → "Prestataire Premium" badge** that
   feeds the assignment ranking.
8. **Property QR** — printable per-property QR (deep link) generated
   client-side; Welcomer opens the right control via native camera / in-app
   BarcodeDetector / manual reference.
9. **Admin-directed assignment** — no self-serve pool; the admin assigns each
   mission (cleaner), tour (delivery) and control (Welcomer), with decision
   support (rating, Premium, load) and email notification.
10. **Email notifications** — new booking, cancellation, dossier submitted,
    access request, quote lead → team; job confirmed → client; dossier to fix →
    cleaner; assignment → worker; reschedule → client. Password reset via
    Firebase Auth.
11. **Robustness & UX** — explicit error handling, **write/upload timeouts**
    (anti-hang), status banners, button loading states, two-click confirm on
    destructive actions.
12. **Design system** — pink / rose theme (magenta + plum), Plus Jakarta Sans
    (portals) / Poppins (landing), progressive disclosure, mobile responsive,
    accessibility (focus, aria, `prefers-reduced-motion`), a deliberate "de-AI"
    human design pass.
13. **Photo retention** — documented manual deletion at 90 days (beta choice).

---

## 8. Configuration & deployment

- Fill in `firebase-config.js`; publish `firestore.rules` + `storage.rules`.
- Enable **Anonymous auth** (public quote wizard) and **Storage**; the **Blaze
  plan** is required for Storage, the email extension and (later) Cloud
  Functions.
- Authorise the Vercel domain in Firebase Authentication.
- Deploy on Vercel (import the repo, no build).
- Install the *Trigger Email from Firestore* extension (`mail` collection).
- Create the first admin by hand (Auth + `users` doc).

Step-by-step details in **SETUP.md** (100 % browser-based, no command line).

---

## 9. Placeholders & out of scope (beta)

- **Online payment (Stripe)** — **placeholder** only (no Stripe account yet);
  ready to wire once keys are provided.
- **External integrations** — Brevo / Zapier / HubSpot / Airtable / Pennylane +
  a REST API: **scaffolded** in `functions/` but deploy/keys-blocked.
- **Automatic PDF-by-email** on quote submission — Cloud Function written,
  **deploy-pending** (Blaze). Today the lead is filed and the team notified; the
  client downloads the PDF in-browser.
- Not built for beta: GPS tracking, AI photo verification, Airbnb import,
  third-party calendar sync.

---

## 10. Deliverables summary (invoicing basis)

| # | Delivered module | Contents |
|---|---|---|
| 1 | Architecture & technical foundation | Static site, Firebase (Auth incl. anonymous / Firestore / Storage), shared data layer, design system, Vercel hosting, security foundation |
| 2 | Public marketing site | Full responsive landing (animated hero, roles, process, verification, pricing, services, FAQ, CTA, footer) |
| 3 | Client portal | Auth + registration, multi-property CRUD, booking with property/beds/bathrooms/guests, supplements, Welcomer opt-in, live HT/VAT/TTC engine, 4-step tracking, cancellation, rating, messaging, per-booking PDF |
| 4 | Cleaner interface | Auth/access request, assigned missions, photo dossier, submission, decline, incidents, ratings received |
| 5 | Delivery interface | Auth/access request, assigned tours, completion |
| 6 | **Automatic quote engine + back-office** | Hourly pricing model, surface×beds time grid, commission, subscription, VAT (HT/TTC); **fully admin-configurable** back-office (all rates/grid/commission/VAT/tax-credit/text/cities) with live config + defensive fallback |
| 7 | **Public quote wizard** | 4-step no-account wizard (anonymous auth), live quote, **crédit d'impôt**, **savings comparator**, PDF, auto-lead to CRM |
| 8 | **Welcomer quality-control system + portal** | Welcomer role & billable tiers, portal (checklist, timestamped photos, digital signature, conformity levels 1/2/3), admin assignment, roster, **quality score / Premium badge**, rules & storage |
| 9 | **Property QR system** | Client-side QR generation (printable, deep link) + Welcomer scan (native camera / in-app BarcodeDetector / manual) |
| 10 | Catalog management | CRUD for services / kits / consumables / linen (photos, HT/TTC, category, stock, unit) |
| 11 | CRM + prospects | Lead pipeline (statuses), CRUD, auto-fed by the wizard |
| 12 | Admin console & operations calendar | Tabs + badges, dispatch (cleaner/delivery/Welcomer), verification queue, messages, incidents, colour-coded calendar with urgency alerts + day panel |
| 13 | Team management & accounting | Roster with member cards, suspend/reactivate; compta with time-frame filters + per-mission HT/VAT/TTC cost breakdown + bonus/malus |
| 14 | Admin dashboard | Business KPIs (quotes, revenue potential/signed, basket, clients, monthly/yearly, conversion) |
| 15 | Directed assignment & rating | Admin assignment model + 1–5 rating + Premium ranking |
| 16 | Email notifications | Full transactional set via the Firestore extension |
| 17 | Security | Complete Firestore + Storage rules (5 roles, bounded transitions, field whitelists) |
| 18 | Backend scaffold | Cloud Functions (PDF email, prospect relay, REST skeleton, Stripe & integration placeholders) — deploy-ready |
| 19 | Legal pages | Terms of use + privacy policy |
| 20 | Documentation & setup | SETUP.md (browser deployment) + this document |

---

*Generated as a scope reference. Invoice amounts are not included (to be filled
in per the agreed rate).*
