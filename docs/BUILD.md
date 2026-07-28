# CleanFlow — Technical Documentation & Scope of Work

Reference document describing the entire CleanFlow platform: every page, its
logic, its rules, the data model, and the infrastructure. Intended as the basis
for invoicing (deliverables summary in Section 10).

---

## 1. Overview

CleanFlow is a web platform for **verified cleaning of Paris short-term
rentals**. Its defining feature: every job is documented with a mandatory set of
photos, **reviewed by a human (the CleanFlow team) before any confirmation is
sent to the client**. Nothing is validated automatically.

Four roles, four distinct interfaces:

| Role | Who | Access |
|---|---|---|
| **Client** | Rental property owner | Free self sign-up |
| **Prestataire** (cleaner) | Partner cleaning company | On approved request |
| **Livreur** (delivery) | Linen / kit delivery service | On approved request |
| **Admin** | CleanFlow team (review + operations) | On approved request |

---

## 2. Technical stack & architecture

- **Static site** — no framework, no build step. HTML + CSS + JavaScript (ES
  modules) served as-is.
- **Firebase backend** (managed, no server to run):
  - **Authentication** — email / password login.
  - **Firestore** — real-time database (live listeners via `onSnapshot`).
  - **Storage** — job and incident photos.
- **Firebase SDK 10.12.2** loaded from the Google CDN (ES modules), no bundler.
- **Vercel hosting** — auto-deploy on every push, static site.
- **Email notifications** — official *Trigger Email from Firestore* extension
  consuming a `mail` collection (no mail server to code).
- **Shared data layer**: `assets/js/shared.js` centralises Firebase access,
  constants, the price grid, and utilities shared by all four interfaces.
- **Single stylesheet**: `assets/ui.css` (common design system).
- **Server-side security**: `firestore.rules` + `storage.rules` enforce role
  separation and every allowed transition — security never depends on the UI.

---

## 3. Site map (routes)

```
/                     Public marketing site (landing)
/app/                 Client portal
/prestataire/         Cleaner interface
/livreur/             Delivery interface
/admin/               CleanFlow admin console
/legal/cgu.html       Terms of use
/legal/confidentialite.html   Privacy policy
```

Supporting files:

```
assets/js/shared.js   Data layer + shared business logic
assets/js/app.js      Client portal logic
assets/js/prestataire.js  Cleaner logic
assets/js/livreur.js  Delivery logic
assets/js/admin.js    Admin console logic
assets/ui.css         Shared design system
firebase-config.js    Firebase project configuration
firestore.rules       Database security rules
storage.rules         Photo storage security rules
vercel.json           Hosting configuration
SETUP.md              Setup guide (100% browser-based)
```

---

## 4. Page-by-page description

### 4.1 — Public landing (`/`)

Responsive marketing page, single narrative column, **no prices shown** (the
price grid is members-only, visible after sign-up).

**Sections:**
- **Sticky nav bar** with anchors and a "Book a cleaning" CTA.
- **Hero** — value proposition (cleaning verified before confirmation), dual
  CTA, animated "Verified cleaning" stamp.
- **Roles** — four cards (client, cleaner, delivery, CleanFlow).
- **Process** — 5-step flow (booking → assignment → cleaning + photos →
  verification → confirmation).
- **Verification band** — human-review emphasis (sample dossier mock-up).
- **Pricing** — two service tiers described **without amounts**; routes to
  sign-up to see the surface-based grid.
- **Services** — kit/linen management, tracking, photo dossier, incidents.
- **FAQ** — common questions (cities, who cleans, price, payment, incidents…).
- **Beta band** (gold) — limited spots / 100% human / no commitment.
- **Final CTA** — account creation + copyable contact email.
- **Footer** — multi-column: spaces (client/cleaner/delivery), links, contact,
  legal.

**Logic / animations:** scroll reveals via IntersectionObserver (disabled under
`prefers-reduced-motion`), hero entrance animation, rotating stamp. No Firebase
data on this page (public).

### 4.2 — Client portal (`/app/`)

**Screens:** loading → sign in / register → application.

**Auth:** email/password sign-in, **free client registration** (name, phone,
email, password), "Forgot password?" (Firebase reset email).

**Application (once signed in):**
- **Welcome banner** — contextual message by progress (no property / property
  added / bookings in progress) + beta note.
- **Your properties** — list (address, postcode, surface, zone), selection,
  **Edit** / **Delete** (delete blocked if a booking is active; two-click
  confirm).
- **New property** (collapsible) — form: street, city, postcode, **surface
  (m²)**, **zone**, access notes. Edit mode reuses the form. Address edits are
  propagated to active bookings (see 7.2).
- **Booking** — for the selected property:
  - service type (standard / deep),
  - **kit quantity** (linen, consumables, €20/unit),
  - **monthly calendar** (French week; past and already-booked dates greyed),
  - **computed price breakdown** (surface-based service + kits + travel fee)
    shown **before** confirming,
  - book button. Above 250 m²: switches to **"Request a quote"** (sends a
    request to the team, no direct booking).
- **Your bookings** — history (newest first, cancelled last) with a **4-step
  tracker** (Booked → Assigned → Cleaning + photos → Confirmed), a note if a
  dossier was returned, **Cancel** button (while `pending`, two-click confirm),
  **1–5 star rating** once the job is verified, and **"Contact the team"**
  (message tied to the booking).

### 4.3 — Cleaner interface (`/prestataire/`)

**Auth:** sign-in + **access request** (company name, phone, email, password,
optional invite code) → `pending` until approved. Dedicated message if the
account is **suspended**.

**Application:**
- **My missions** — only missions **assigned by the team** (the cleaner no
  longer self-selects from a pool). Selecting a mission → dossier:
  - upload of the required photos (slot grid), with error handling and a
    maximum timeout (anti-hang),
  - **Submit for verification** button (enabled when all photos present),
  - **Decline mission** button (for `accepted` or returned `rejected`
    missions) — two-click confirm; the mission returns to the team.
- **Report an incident** (collapsible) — type (broken / lost object / other),
  description, optional photo.
- **My ratings** (collapsible) — average /5 + list of client-rated missions.

### 4.4 — Delivery interface (`/livreur/`)

**Auth:** same as the cleaner (access request, statuses).

**Application:**
- **Linen / kit tours** — only tours **assigned by the team** (`livreurId`).
  Each tour: address, date, reference, **Mark tour done** / undo (`linenDone`).

### 4.5 — Admin console (`/admin/`)

The richest interface. **Organised into tabs** (sticky bar, real-time count
badges showing what needs action), to avoid scrolling — one panel visible at a
time.

**Auth:** sign-in + admin access request (the very first admin is created by
hand in the Firebase console, see SETUP.md).

**Tabs:**

- **To assign** *(badge)*:
  - *Missions to assign* — pending bookings; cleaner dropdown **ranked by
    rating then by load**, each option showing `★ rating (reviews) · N in
    progress`. Assigning → emails the cleaner.
  - *Deliveries to assign* — bookings with kits and no delivery person;
    delivery dropdown ranked by load. Assigning → emails the delivery person.

- **Calendar**:
  - *Overview* — 4 metrics (awaiting cleaner, in progress, to verify,
    confirmed).
  - *Monthly calendar* — all bookings by date, **colour-coded by status**, with
    **unassigned missions due ≤ 3 days (or overdue) flagged red** (dot + ⚠
    pill). Clicking a date → **day panel** listing the bookings with actions:
    **Assign**, **Verify**, **Cancel mission**, **Reschedule** (date picker).

- **Verification** *(badge)*:
  - *Queue* — submitted dossiers.
  - *Selected dossier* — photo grid, mandatory rejection note, **Approve**
    (→ client notified) / **Return to cleaner** (→ cleaner notified) buttons,
    attached incidents.

- **Messages** *(badge)*:
  - *Client messages* — questions/issues, mark "handled".
  - *Open incidents* — reported by cleaners, mark "handled".

- **Team** *(badge)*:
  - *Cleaners & delivery* — roster of approved members: **clickable name
    (detail card)**, current load, **average rating** (cleaners). Click → 
    **modal**: contact, load, rating, missions in progress, action **Remove
    from team** (suspension, two-click confirm) / **Reactivate**. Suspended
    members stay listed (greyed) for reactivation.
  - *Access requests* — approve / reject each request (invite-code check).

- **Accounting (Compta)**:
  - Totals: missions, gross amount, bonus/malus, **net**.
  - Ledger of missions (cancelled excluded) with, per mission, a
    **discretionary bonus (+) or malus (−)** + note; net recomputed.

### 4.6 — Legal pages (`/legal/`)

- **Terms of use (CGU)** — service, beta, accounts, booking & pricing (surface +
  kits + travel fee, quote > 250 m²), workflow/verification, photos (90-day
  retention), incidents, liability, termination, IP, governing law.
- **Privacy policy** — data and photo handling.

---

## 5. Data model (Firestore)

- **`users/{uid}`** — `uid`, `role` (client/prestataire/livreur/admin),
  `accountStatus` (pending/approved/rejected/suspended), `name`, `email`,
  `phone`, `inviteCode` (team requests), `createdAt`.
- **`properties/{id}`** — `ownerId`, `street`, `city`, `postalCode`,
  `surface` (m²), `zone`, `notes`, `createdAt`.
- **`bookings/{id}`** — `clientId`, `propertyId`, `propertyAddress` (copy),
  `prestataireId`, `livreurId`, `serviceType`, `surface`, `zone`, `kitCount`,
  `linenRequested`, `prestationPrice`, `travelFee`, `price` (total),
  `scheduledDate`, `status`, `createdAt`; then over the lifecycle: `adminNote`,
  `verifiedBy`, `verifiedAt`, `rating`, `ratedAt`, `linenDone`, `adjustment`,
  `adjustmentNote`.
- **`photos/{id}`** — `bookingId`, `slot`, `downloadUrl`, `uploadedBy`,
  `verified`, `verifiedBy`, `verifiedAt`.
- **`incidents/{id}`** — `bookingId`, `reportedBy`, `type`, `description`,
  `photoRefs`, `reportedAt`, `status`.
- **`messages/{id}`** — `bookingId`, `clientId`, `clientEmail`, `clientName`,
  `propertyAddress`, `text`, `status`, `createdAt`.
- **`mail/{id}`** — `to`, `message.{subject,text}`, `createdAt` (consumed by the
  email extension).

**Booking lifecycle:**
`pending` → (admin assigns) `accepted` → (photos) `submitted` →
`verified` **or** `rejected` (human decision). `rejected` can be resubmitted.
`cancelled` = cancelled (client while `pending`, or admin at any stage). A
cleaner can **decline** (`accepted`/`rejected` → `pending`).

---

## 6. Security rules (server-side)

All authorisation is **proven server-side**; the UI is never the only barrier.

**Role model:** a role is effective only if `accountStatus == approved` (a
pending/rejected/suspended account has **no** read/write rights at all).

**`firestore.rules` — key points:**
- *users* — each reads their own doc; admin lists; creation is constrained
  (client → approved, team roles → pending); admin may set a member to
  approved/rejected/**suspended**.
- *properties* — read/write restricted to the owner (plus admin read).
- *bookings* — partitioned reads (client, **assigned** cleaner only,
  **assigned** delivery only, admin); client creation with validated structure
  (valid service, numeric price ≥ 0, integer kits ≥ 0); strictly bounded
  transitions: client cancel, client rating, cleaner submit/decline, delivery
  `linenDone`, and **admin**: assign cleaner, assign delivery, verdict,
  **cancel**, **reschedule**, **bonus/malus adjustment**.
- *photos* — read admin / assigned cleaner / owning client; write assigned
  cleaner; admin validation.
- *mail* — write only to the team address (or any address for admin); never
  readable client-side.
- *messages* — client create, admin read/close.
- *incidents* — cleaner create, admin read/close.

**`storage.rules`** — checks the role **via Firestore** (cross-service rules)
and the mission assignment: photos readable by admin / assigned cleaner / owning
client, written by the assigned cleaner; incidents write cleaner, read admin.

---

## 7. Cross-cutting features

1. **Access & approval flow** — free client sign-up; request → verification
   (invite code) → approve/reject for team roles; `pending`/`approved`/
   `rejected`/**`suspended`** lifecycle with dedicated messages on each portal.
2. **Denormalised address** — the address is copied onto the booking (cleaner
   and delivery don't read the property record); editing the property
   propagates the new address to active bookings.
3. **Pricing engine** — grid by surface band (m²) × service type, per-unit kits
   (€20), travel fee (flat, planned per zone), computed and shown **before
   confirmation**, custom quote above 250 m². Single source of truth in
   `shared.js`.
4. **Admin-directed assignment** — no self-serve pool; the admin assigns each
   mission to a cleaner and each tour to a delivery person, with decision
   support (rating + load) and email notification.
5. **Client rating** — 1–5 stars after verification, tied to the cleaner;
   surfaced to the cleaner (their ratings) and the admin (roster + assignment
   dropdown ranking).
6. **Admin console** — tabs + action badges, ops calendar (colours, ≤ 3-day red
   urgencies, day panel), roster with member cards, cancellation, rescheduling,
   bonus/malus accounting.
7. **Email notifications** — new booking, cancellation, dossier submitted,
   access request → team; job confirmed → client; dossier to fix → cleaner;
   mission/tour assigned → worker; reschedule → client. Password reset via
   Firebase Auth.
8. **Robustness & UX** — explicit error handling (permissions, network, storage
   not enabled), **maximum timeout** on writes and uploads (anti-hang), status
   banners, button loading states, and a **two-click confirm on the button**
   (replaces `window.confirm`, which is silent if the browser blocks dialogs)
   for all destructive actions.
9. **Design system** — signature style (hard offset-shadow blocks, Plus Jakarta
   Sans + JetBrains Mono, Klein blue + gold), progressive disclosure
   (collapsible cards), mobile responsive, accessibility (visible focus, aria,
   `prefers-reduced-motion`).
10. **Photo retention** — documented manual deletion at 90 days (beta choice, no
    Cloud Function).

---

## 8. Configuration & deployment

- Fill in `firebase-config.js` (public client-side key).
- Publish `firestore.rules` and `storage.rules` in the Firebase console.
- Enable Storage (Blaze plan required for photo storage).
- Authorise the Vercel domain in Firebase Authentication.
- Deploy on Vercel (import the repo, no build).
- Install the *Trigger Email from Firestore* extension (`mail` collection).
- Create the first admin account by hand (Auth + `users` doc).

Step-by-step details in **SETUP.md** (100% browser-based, no command line).

---

## 9. Out of scope (deliberately not built for the beta)

Online payment (settled directly with the team), GPS tracking, automatic /
AI photo verification, Airbnb import, third-party calendar integrations,
drafting of the cleaner code-of-conduct rules (content to be provided).

---

## 10. Deliverables summary (invoicing basis)

| # | Delivered module | Contents |
|---|---|---|
| 1 | Architecture & technical foundation | Static site, Firebase integration (Auth/Firestore/Storage), shared data layer, design system, Vercel hosting |
| 2 | Public marketing site | Full responsive landing (animated hero, roles, process, verification, pricing, services, FAQ, CTA, footer) |
| 3 | Client portal | Auth + registration, multi-property management (CRUD), booking calendar, live price engine, 4-step tracking, cancellation, rating, messaging to the team |
| 4 | Cleaner interface | Auth/access request, assigned missions, photo dossier upload, submission, decline, incidents, ratings received |
| 5 | Delivery interface | Auth/access request, assigned tours, tour completion |
| 6 | Admin console | Tabs + badges, dispatch (cleaner/delivery assignment with decision support), photo verification queue, messages, incidents, access requests |
| 7 | Admin operations calendar | Colour-coded monthly view, urgency alerts, day panel with actions |
| 8 | Team management | Roster, member cards (modal), suspend/reactivate |
| 9 | Accounting | Mission ledger, totals, discretionary bonus/malus |
| 10 | Pricing engine | Surface × service grid, kits, travel fee, custom quote |
| 11 | Directed assignment & rating | Admin assignment model + 1–5 rating system tied to assignment |
| 12 | Email notifications | Full set of transactional emails via the Firestore extension |
| 13 | Security | Complete Firestore + Storage rules (role separation, bounded transitions) |
| 14 | Legal pages | Terms of use + privacy policy |
| 15 | Documentation & setup | SETUP.md (browser deployment) + this document |

---

*Generated as a scope reference. Invoice amounts are not included (to be filled
in per the agreed rate).*
