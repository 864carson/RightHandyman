# Multi-Tenant Auth Base App

A Node.js/Express starter for multi-tenant apps with OAuth login (Google
"Gmail" login + GitHub as a second example provider) and JWT-based API auth.
Built to be extended, not to be a finished product.

## Stack

- **Express** – HTTP server
- **Passport** – OAuth (`passport-google-oauth20`, `passport-github2`)
- **JWT** (`jsonwebtoken`) – stateless API auth after login
- **In-memory repository layer** – swap for Postgres/Mongo/etc. later (see below)
- **Jest + Supertest** – unit and integration tests

## How multi-tenancy works

- Every `User` has a `tenantId` and a `role` (`owner` | `admin` | `member`).
  The first user ever created for a tenant automatically becomes `owner`;
  everyone after that defaults to `member`. Tenants are otherwise fully
  isolated — different data, different users, no crossover.
- Tenants are resolved per-request by `src/middleware/tenantResolver.js`
  (used by `/users/*`, `/customers/*`, `/opportunities/*`), either from an
  `x-tenant-id` header (default) or a subdomain (`acme.yourapp.com`, via
  `TENANT_RESOLUTION=subdomain`). `/tenants/*` routes instead resolve the
  tenant from the URL itself (`src/middleware/loadTenantParam.js`).
- JWTs embed `tenantId`. `requireAuth` rejects a token whose `tenantId`
  doesn't match the resolved tenant.

## How the permission system works

Routes aren't gated by role directly — they're gated by **permission**
(`resource:action` strings, e.g. `customers:delete`), and a role is just a
named bundle of permissions that a tenant can customize. This is what makes
things like "can members delete customers?" a configuration choice per
tenant rather than a hardcoded rule.

- `src/config/permissions.js` defines every permission and the **built-in
  default** bundle for each role (`DEFAULT_ROLE_PERMISSIONS`). By default:
  `owner` gets everything; `admin` gets full CRUD on customers/opportunities/
  jobs/estimates plus catalog management, member management, and tenant
  updates; `member` gets create/read/update on customers, opportunities,
  jobs, and estimates (including send + recording a customer's approve/
  reject decision) plus read-only catalog access, but not delete rights on
  jobs/estimates or catalog management — protecting the shared price book
  is treated as an owner/admin concern, day-to-day estimating is not.
- `src/models/RolePermissions.js` stores per-tenant **overrides**. If a
  tenant hasn't customized a role, its built-in default applies. A tenant
  owner can call `PUT /tenants/:id/role-permissions/:role` to replace a
  role's permission set entirely — narrowing it (e.g. members lose
  `customers:update`) or widening it (e.g. members gain `customers:delete`).
- `src/middleware/requirePermission.js` is what routes actually use
  (`requirePermission(PERMISSIONS.CUSTOMERS_DELETE)`). It looks up the
  caller's role fresh from the repository and checks it against that
  tenant's *effective* permission set (override, or default) — so a
  permission change takes effect on the very next request, not after the
  token expires.
- A couple of things are **not** part of this overridable system on
  purpose: deleting a tenant outright, and managing the permission matrix
  itself. Both are checked via `requireRole(['owner'])` directly, so an
  owner can never accidentally configure themselves out of their own
  tenant.
- `GET /tenants/:id/role-permissions/catalog` lists every permission key and
  role name, so a frontend can build a permission-editor UI without
  hardcoding the list. `GET /users/me/permissions` returns the *caller's*
  effective role + permissions, handy for showing/hiding UI elements.

## How login and sessions work

1. Client hits `GET /auth/google?tenant=<slug>` (or `/auth/github?tenant=<slug>`).
2. The tenant is looked up and encoded into the OAuth `state` param, so it
   survives the redirect round-trip without needing cookies.
3. Provider redirects to `GET /auth/google/callback`. The strategy's verify
   callback decodes `state`, then calls `findOrCreateUser()`
   (`src/controllers/authController.js`) which:
   - looks up an existing user by `(tenantId, provider, providerId)`
   - falls back to matching by `(tenantId, email)` — links a second login
     method to the same account, and is also how a pending invite (see
     Membership below) gets activated on the invitee's first real login
   - creates a new user if neither matches (`owner` if they're the first
     member of the tenant, `member` otherwise)
4. The callback returns `{ accessToken, refreshToken, tokenType, user }`.
   `accessToken` is short-lived (`JWT_EXPIRES_IN`, default 15m);
   `refreshToken` is long-lived (`REFRESH_TOKEN_EXPIRES_IN`, default 30d)
   and opaque (stored server-side as a hash, never as a JWT).
5. API calls send `Authorization: Bearer <accessToken>` plus
   `x-tenant-id: <slug>`.
6. When the access token expires, exchange the refresh token for a new pair:
   `POST /auth/refresh { refreshToken }`. The old refresh token is revoked
   as part of this (rotation) — reusing it afterward fails.
7. `POST /auth/logout { refreshToken?, everywhere? }` (requires
   `Authorization`) revokes the given refresh token, or every refresh token
   for that user if `everywhere: true` ("log out all devices"). It also
   blocklists the current access token's `jti` so it stops working
   immediately instead of lingering until its natural expiry.

## How estimating works (jobs, estimates, catalog & templates)

This is the estimating feature: create a job for a customer, build an
estimate with line items (materials/labor/equipment/subcontract/travel),
see true cost vs. price vs. margin instantly, send it, and let the customer
approve it — without anyone having to remember trip charges or dump fees
from memory.

**The data model.** A `Job` is the hub — created directly, or by converting
a won `Opportunity` (`POST /opportunities/:id/convert-to-job`) — and it
holds a customer's estimate(s), status, and (eventually) invoice together,
so pulling up a customer's history doesn't take ten separate lookups
(`GET /jobs/:id/estimates` returns every version ever created for that
job). An `Estimate` belongs to a job and has a list of line items; nothing
about pricing is ever stored pre-computed — `totals` are recalculated fresh
from the line items on every read (`src/services/estimateCalculations.js`),
so a stale total after editing a line item is a bug class that can't
happen here.

**Cost, markup, and margin — always both.** Every line item has a
`quantity`, `unitCost` (what it costs the business), and either a percent
or fixed `markupValue`. The engine computes `cost`, `markupAmount`,
`price`, and `marginPercent` per line, then rolls that up by category and
for the whole estimate (`totalCost → totalMarkup → subtotalPrice → tax →
totalPrice → deposit → balanceDue`). New catalog items default their
markup % by category (materials 30%, labor 50%, equipment 20%, subcontract
15%, travel a flat fee) per `src/config/estimateDefaults.js` — labor
carries the highest recovery since it carries the most overhead/risk, and
every default is overridable per line or per catalog item.

**Two views, on purpose.** `estimateController.buildInternalView()` shows
staff everything (cost, markup $, markup %, margin, internal notes).
`buildCustomerView()` strips all of that — a customer only ever sees
description/quantity/unit/price per line, a category price summary, scope
language, terms, and the bottom-line numbers. The internal view is what
`GET /estimates/:id` and `GET /jobs/:id/estimates` return; add
`?view=customer` to preview exactly what the customer link will show.

**Scope language and change orders.** Every estimate carries
`scopeIncluded`/`scopeExcluded` text and a `changeOrderNotice` (defaulted
to a standard "anything outside this scope needs a written change order"
sentence) — this is the single biggest thing that prevents "I thought that
was included" disputes. `paymentTerms` and a `depositType`/`depositValue`
(percent or fixed) cover "50% deposit, balance on completion" out of the
box.

**Versioning.** `POST /estimates/:id/revise` creates a new linked version
(`version`, `previousVersionId`, `rootEstimateId` — `GET
/estimates/:id/versions` walks the whole chain). If the version being
revised was still a draft/sent/rejected/expired, it's marked `superseded`.
If it was already **`approved`**, revising it with `asChangeOrder: true`
keeps that version's status as `approved` — an honest, permanent record of
what the customer actually signed off on — while the new draft carries the
added scope forward. A plain revise (not a change order) is blocked from
an approved parent's already-superseded state, but change orders
specifically require an approved parent, so "still shopping the quote
around" and "customer already said yes, scope changed after the fact" stay
clearly distinct.

**The customer-facing link.** Every estimate gets an unguessable
`shareToken` (same opaque-token pattern this app already uses for refresh
tokens). `GET /public/estimates/:shareToken` and `POST
/public/estimates/:shareToken/approve` (or `/reject`) require **no login
at all** — that's the "shareable link + I-approve checkbox" from the spec,
and it never returns cost/markup/margin. Approving flips the job from
`estimating` to `approved` automatically (unless the job's already moved
further along, e.g. `scheduled`). A link past its `validUntil` date
returns `410 Gone` on approve/reject instead of silently accepting a stale
price.

**Catalog and templates.** `CatalogItem`s are a shared, tenant-wide price
book (one list per company, not per user — simpler to keep accurate for a
1-15 person shop); `EstimateTemplate`s bundle several catalog-style line
items into a package ("Weekly mow + edge", "French drain, 50ft") with
typical quantities pre-filled, so the estimator taps a template and only
adjusts numbers instead of starting from a blank screen. Both are copied
by value onto an estimate/line item when used — editing a catalog item or
template later never changes an estimate that already went out.
`POST /catalog-items/seed-defaults` loads a small starter set (~15 items +
3 templates across landscaping and drainage, see
`src/seed/estimateCatalogSeed.js`) — enough to prove the mechanism end to
end; add your own regional/specialty items and packages from there.

**What's intentionally not in v1** (see the spec's own "nice to have
later" list): PDF generation (the public link + `?view=customer` give a
clean structured view a frontend can render/print; add a PDF library later
if you want an actual file), real photo/file upload storage (the `photos`
field on `Job` just stores `{url, caption}` references — wire up S3/
Cloudinary/etc. and point the URL there), and quoted-vs-actual job-cost
tracking (the line item schema is generic enough to extend with an
`actualQuantity`/`actualCost` pair later without a migration headache).

## API reference

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | liveness check |
| GET | `/auth/:provider?tenant=<slug>` | none | start OAuth (`google`, `github`) |
| GET | `/auth/:provider/callback` | none | OAuth callback → `{accessToken, refreshToken, user}` |
| POST | `/auth/refresh` | refresh token in body | rotates and returns a new pair |
| POST | `/auth/logout` | Bearer | revokes refresh token(s) + blocklists access token |
| POST | `/tenants` | none | create a tenant `{name, slug}` |
| GET | `/tenants/:idOrSlug` | none | fetch a tenant |
| PATCH | `/tenants/:idOrSlug` | Bearer, `tenant:update` | update `{name?, slug?}` |
| DELETE | `/tenants/:idOrSlug` | Bearer, owner (fixed) | deletes tenant + all members/customers/opportunities/jobs/estimates/catalog/templates |
| GET | `/tenants/:idOrSlug/members` | Bearer | list members (active + invited) |
| POST | `/tenants/:idOrSlug/members/invite` | Bearer, `members:invite` | invite by email `{email, role?}` |
| DELETE | `/tenants/:idOrSlug/members/:userId` | Bearer, `members:remove` | remove a member (only owner removes owner) |
| GET | `/tenants/:idOrSlug/role-permissions/catalog` | Bearer | list all permission keys + role names |
| GET | `/tenants/:idOrSlug/role-permissions` | Bearer, owner/admin | effective permission matrix for the tenant |
| PUT | `/tenants/:idOrSlug/role-permissions/:role` | Bearer, owner (fixed) | replace a role's permissions `{permissions: string[]}` |
| DELETE | `/tenants/:idOrSlug/role-permissions/:role` | Bearer, owner (fixed) | revert a role to its built-in default |
| GET | `/users/me` | Bearer + `x-tenant-id` | current user |
| GET | `/users/me/permissions` | Bearer + `x-tenant-id` | current user's role + effective permissions |
| GET | `/users` | Bearer + `x-tenant-id` | list users in tenant |
| GET | `/users/:id` | Bearer + `x-tenant-id` | fetch a user |
| PATCH | `/users/:id` | Bearer + `x-tenant-id` | self can edit displayName/avatarUrl; owner/admin can also edit role/status/others |
| DELETE | `/users/:id` | Bearer + `x-tenant-id` | self can delete own account; owner/admin can remove others (only owner removes owner) |
| GET | `/customers` | Bearer + `x-tenant-id`, `customers:read` | list customers |
| GET | `/customers/:id` | Bearer + `x-tenant-id`, `customers:read` | fetch a customer |
| GET | `/customers/:id/opportunities` | Bearer + `x-tenant-id`, `customers:read` | that customer's opportunities |
| POST | `/customers` | Bearer + `x-tenant-id`, `customers:create` | create `{name, email?, phone?, company?, notes?}` |
| PATCH | `/customers/:id` | Bearer + `x-tenant-id`, `customers:update` | update customer fields |
| DELETE | `/customers/:id` | Bearer + `x-tenant-id`, `customers:delete` | delete + cascade-delete its opportunities |
| GET | `/opportunities?customerId=` | Bearer + `x-tenant-id`, `opportunities:read` | list, optionally filtered to one customer |
| GET | `/opportunities/:id` | Bearer + `x-tenant-id`, `opportunities:read` | fetch an opportunity |
| POST | `/opportunities` | Bearer + `x-tenant-id`, `opportunities:create` | create `{customerId, name, stage?, amount?, currency?, closeDate?, notes?}` |
| PATCH | `/opportunities/:id` | Bearer + `x-tenant-id`, `opportunities:update` | update opportunity fields |
| DELETE | `/opportunities/:id` | Bearer + `x-tenant-id`, `opportunities:delete` | delete an opportunity |
| POST | `/opportunities/:id/convert-to-job` | Bearer + `x-tenant-id`, `jobs:create` | marks the opportunity `won` and creates a linked `Job`, `{title?, siteAddress?, description?, weatherSensitive?, weatherNotes?, notes?, photos?}` |
| GET | `/customers/:id/jobs` | Bearer + `x-tenant-id`, `customers:read` | that customer's jobs |
| GET | `/jobs?customerId=` | Bearer + `x-tenant-id`, `jobs:read` | list, optionally filtered to one customer |
| GET | `/jobs/:id` | Bearer + `x-tenant-id`, `jobs:read` | fetch a job |
| GET | `/jobs/:id/estimates` | Bearer + `x-tenant-id`, `jobs:read` | every estimate version ever created for this job, full internal detail, newest first |
| POST | `/jobs` | Bearer + `x-tenant-id`, `jobs:create` | create `{customerId, opportunityId?, title, description?, siteAddress?, weatherSensitive?, weatherNotes?, notes?, photos?}` |
| PATCH | `/jobs/:id` | Bearer + `x-tenant-id`, `jobs:update` | update job fields (title, description, siteAddress, weather flags, notes, photos, status) |
| DELETE | `/jobs/:id` | Bearer + `x-tenant-id`, `jobs:delete` | delete + cascade-delete every estimate version under it |
| GET | `/estimates?jobId=` | Bearer + `x-tenant-id`, `estimates:read` | list (internal view), optionally filtered to one job |
| GET | `/estimates/:id` | Bearer + `x-tenant-id`, `estimates:read` | fetch one, internal view by default, `?view=customer` to preview the sanitized customer view |
| GET | `/estimates/:id/versions` | Bearer + `x-tenant-id`, `estimates:read` | full revision chain, oldest first |
| POST | `/estimates` | Bearer + `x-tenant-id`, `estimates:create` | create a draft `{jobId, title?, lineItems?, scopeIncluded?, scopeExcluded?, taxRate?, depositType?, depositValue?, paymentTerms?, validDays?}` |
| POST | `/estimates/from-template` | Bearer + `x-tenant-id`, `estimates:create` | create a draft from a template `{jobId, templateId}` |
| PATCH | `/estimates/:id` | Bearer + `x-tenant-id`, `estimates:update` | in-place edit — **draft only**, `409` otherwise (use `/revise`) |
| POST | `/estimates/:id/revise` | Bearer + `x-tenant-id`, `estimates:update` | create a new linked version `{asChangeOrder?, ...fields to change}` — `asChangeOrder: true` requires the version being revised to be `approved` |
| POST | `/estimates/:id/send` | Bearer + `x-tenant-id`, `estimates:send` | draft → sent |
| POST | `/estimates/:id/approve` | Bearer + `x-tenant-id`, `estimates:record-response` | staff-recorded approval `{approvedByName?, signatureText?}` |
| POST | `/estimates/:id/reject` | Bearer + `x-tenant-id`, `estimates:record-response` | staff-recorded rejection `{reason?}` |
| DELETE | `/estimates/:id` | Bearer + `x-tenant-id`, `estimates:delete` | delete — **draft only**, `409` otherwise |
| GET | `/public/estimates/:shareToken` | **none** | sanitized customer view — no cost/markup/margin ever included |
| POST | `/public/estimates/:shareToken/approve` | **none** | customer self-approves `{approvedByName?, signatureText?}`; `410` if past `validUntil` |
| POST | `/public/estimates/:shareToken/reject` | **none** | customer self-rejects `{reason?}`; `410` if past `validUntil` |
| GET | `/catalog-items?trade=&category=&includeInactive=` | Bearer + `x-tenant-id`, `catalog:read` | list catalog items |
| GET | `/catalog-items/:id` | Bearer + `x-tenant-id`, `catalog:read` | fetch a catalog item |
| POST | `/catalog-items` | Bearer + `x-tenant-id`, `catalog:manage` | create `{trade, category?, name, unit, defaultUnitCost?, defaultMarkupType?, defaultMarkupValue?, notes?}` |
| POST | `/catalog-items/seed-defaults` | Bearer + `x-tenant-id`, `catalog:manage` | load the built-in starter catalog + templates into this tenant |
| PATCH | `/catalog-items/:id` | Bearer + `x-tenant-id`, `catalog:manage` | update catalog item fields |
| DELETE | `/catalog-items/:id` | Bearer + `x-tenant-id`, `catalog:manage` | soft-delete (`active: false`) — never breaks estimates that already used it |
| GET | `/estimate-templates?trade=&includeInactive=` | Bearer + `x-tenant-id`, `catalog:read` | list templates |
| GET | `/estimate-templates/:id` | Bearer + `x-tenant-id`, `catalog:read` | fetch a template |
| POST | `/estimate-templates` | Bearer + `x-tenant-id`, `catalog:manage` | create `{trade, name, description?, lineItems: [...]}` |
| PATCH | `/estimate-templates/:id` | Bearer + `x-tenant-id`, `catalog:manage` | update template fields |
| DELETE | `/estimate-templates/:id` | Bearer + `x-tenant-id`, `catalog:manage` | delete a template |

`stage` is one of `lead`, `qualified`, `proposal`, `won`, `lost` (default `lead`).
`Job.status` is one of `estimating`, `approved`, `scheduled`, `in_progress`,
`completed`, `cancelled` (default `estimating`). `Estimate.status` is one of
`draft`, `sent`, `approved`, `rejected`, `expired`, `superseded`. Line item
`category` is one of `materials`, `labor`, `equipment`, `subcontract`,
`travel`, `other`; `markupType`/`depositType` is `percent` or `fixed`.

## Project layout

```
src/
  app.js                  Express app assembly (no listen — testable)
  server.js               Starts the app
  config/passport.js      Registers OAuth strategies
  config/permissions.js    Permission catalog + built-in default role→permission bundles
  config/estimateDefaults.js  Default markup %/deposit/validity/change-order-notice constants
  controllers/authController.js       findOrCreateUser, token issuance, refresh, logout
  controllers/membershipController.js Invite / remove tenant members
  controllers/estimateController.js   Job/estimate orchestration + internal vs. customer view builders
  services/estimateCalculations.js    Pure cost/markup/price/tax/deposit math (no side effects)
  seed/estimateCatalogSeed.js         Starter catalog items + templates (landscaping + drainage)
  middleware/tenantResolver.js        Resolves req.tenant from header/subdomain
  middleware/loadTenantParam.js       Resolves req.tenant from a URL param
  middleware/auth.js                  Verifies JWT, checks blocklist, enforces tenant match
  middleware/requireRole.js           Role-gates a route (fixed roles, not overridable)
  middleware/requirePermission.js     Permission-gates a route (per-tenant overridable)
  models/db.js              In-memory store (swap this for a real DB)
  models/Tenant.js          Tenant repository (create/find/update/remove)
  models/User.js            User repository, tenant-scoped (create/update/delete/link)
  models/Customer.js        Customer repository, tenant-scoped
  models/Opportunity.js     Opportunity repository, tenant-scoped, linked to a customer
  models/Job.js              Job repository, tenant-scoped, linked to a customer (+ optional opportunity)
  models/Estimate.js         Estimate repository: versioning, status transitions, share tokens
  models/CatalogItem.js      Shared per-tenant price-book repository
  models/EstimateTemplate.js Packaged line-item bundles ("Weekly mow + edge", etc.)
  models/RolePermissions.js Per-tenant permission overrides on top of the defaults
  models/RefreshToken.js    Refresh token repository (hashed at rest, rotated on use)
  models/TokenBlocklist.js  Revoked access-token jtis (for logout)
  routes/auth.js            OAuth init/callback, refresh, logout
  routes/tenant.js          Tenant CRUD + membership invite/remove + permission management
  routes/user.js            User CRUD (self-service + admin)
  routes/customer.js        Customer CRUD (permission-gated)
  routes/opportunity.js     Opportunity CRUD + convert-to-job (permission-gated)
  routes/job.js              Job CRUD + per-job estimate history (permission-gated)
  routes/estimate.js         Estimate CRUD, revise/send/approve/reject (permission-gated)
  routes/catalogItem.js      Catalog item CRUD + seed-defaults (permission-gated)
  routes/estimateTemplate.js Estimate template CRUD (permission-gated)
  routes/publicEstimate.js   Unauthenticated customer view/approve/reject by share token
  utils/jwt.js              sign/verify (adds a jti to every token)
  utils/oauthState.js       Encodes tenant context into OAuth `state`
tests/
  unit/                    Repository, calculation engine, controller, middleware, util tests
  integration/             Full-app route tests via supertest
  helpers/setup.js         Test DB reset + tenant seeding helper
```

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
- `JWT_SECRET` / `SESSION_SECRET` — any random strings for local dev.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from the
  [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
  Set the authorized redirect URI to `http://localhost:3000/auth/google/callback`.
  This covers Gmail and any Google Workspace account.
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — optional, from
  [GitHub OAuth Apps](https://github.com/settings/developers), same idea.

A provider is only registered if its client ID/secret are set, so you can
run with just Google configured.

```bash
npm run dev     # start with auto-reload
npm test        # run the test suite
npm run test:coverage
```

## Trying it locally

```bash
# 1. Create a tenant
curl -X POST localhost:3000/tenants -H 'Content-Type: application/json' \
  -d '{"name":"Acme Inc","slug":"acme"}'

# 2. Start login (opens in browser, not curl)
open "http://localhost:3000/auth/google?tenant=acme"

# 3. After the redirect, you get { accessToken, refreshToken, user }. Use it:
curl localhost:3000/users/me -H "x-tenant-id: acme" -H "Authorization: Bearer <accessToken>"

# 4. When the access token expires, refresh it:
curl -X POST localhost:3000/auth/refresh -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<refreshToken>"}'

# 5. Log out (revokes the refresh token + blocklists the access token):
curl -X POST localhost:3000/auth/logout \
  -H "Authorization: Bearer <accessToken>" -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<refreshToken>"}'

# 6. Invite a teammate before they've ever logged in (owner/admin only):
curl -X POST localhost:3000/tenants/acme/members/invite \
  -H "Authorization: Bearer <accessToken>" -H 'Content-Type: application/json' \
  -d '{"email":"teammate@example.com","role":"member"}'

# 7. Create a customer and an opportunity for them:
curl -X POST localhost:3000/customers -H "x-tenant-id: acme" \
  -H "Authorization: Bearer <accessToken>" -H 'Content-Type: application/json' \
  -d '{"name":"Wayne Enterprises","email":"contact@wayne.com"}'

curl -X POST localhost:3000/opportunities -H "x-tenant-id: acme" \
  -H "Authorization: Bearer <accessToken>" -H 'Content-Type: application/json' \
  -d '{"customerId":"<customerId>","name":"Batmobile deal","amount":250000,"stage":"qualified"}'

# 8. Let members delete customers too, for this tenant (owner only):
curl -X PUT localhost:3000/tenants/acme/role-permissions/member \
  -H "Authorization: Bearer <accessToken>" -H 'Content-Type: application/json' \
  -d '{"permissions":["customers:create","customers:read","customers:update","customers:delete","opportunities:create","opportunities:read","opportunities:update"]}'

# 9. Turn that opportunity into a job (marks it "won" automatically):
curl -X POST localhost:3000/opportunities/<opportunityId>/convert-to-job \
  -H "x-tenant-id: acme" -H "Authorization: Bearer <accessToken>" -H 'Content-Type: application/json' \
  -d '{"siteAddress":"1007 Mountain Drive, Gotham"}'

# 10. Load the starter catalog + templates for this tenant (one-time, per tenant):
curl -X POST localhost:3000/catalog-items/seed-defaults \
  -H "x-tenant-id: acme" -H "Authorization: Bearer <accessToken>"

# 11. Build a draft estimate from a template (grab a templateId from step 10's response):
curl -X POST localhost:3000/estimates/from-template -H "x-tenant-id: acme" \
  -H "Authorization: Bearer <accessToken>" -H 'Content-Type: application/json' \
  -d '{"jobId":"<jobId>","templateId":"<templateId>"}'

# 12. Send it, then check what the customer will actually see:
curl -X POST localhost:3000/estimates/<estimateId>/send \
  -H "x-tenant-id: acme" -H "Authorization: Bearer <accessToken>"

curl "localhost:3000/estimates/<estimateId>?view=customer" \
  -H "x-tenant-id: acme" -H "Authorization: Bearer <accessToken>"

# 13. The customer approves via the public link -- no login, no tenant header,
#     just the estimate's shareToken (from any of the responses above):
curl -X POST localhost:3000/public/estimates/<shareToken>/approve \
  -H 'Content-Type: application/json' -d '{"approvedByName":"Bruce Wayne"}'

# 14. Scope changed after the fact? Add a change order (requires the version
#     you're revising to already be approved). lineItems REPLACES the whole
#     list, so include the original items plus whatever's new:
curl -X POST localhost:3000/estimates/<estimateId>/revise -H "x-tenant-id: acme" \
  -H "Authorization: Bearer <accessToken>" -H 'Content-Type: application/json' \
  -d '{"asChangeOrder":true,"lineItems":[{"description":"Original scope item(s) here...","category":"materials","unit":"linear foot","quantity":50,"unitCost":1.8,"markupType":"percent","markupValue":35},{"description":"Extra 20ft of pipe (rock found)","category":"materials","unit":"linear foot","quantity":20,"unitCost":1.8,"markupType":"percent","markupValue":35}]}'
```

## Adding another provider

1. `npm install passport-<provider>`
2. Add a `passport.use('<provider>', new Strategy(...))` block in
   `src/config/passport.js`, following the Google/GitHub pattern: decode
   `state` for `tenantId`, map the provider's profile to
   `{providerId, email, displayName, avatarUrl}`, call `findOrCreateUser()`.
3. Add `'<provider>': { scope: [...] }` to `SUPPORTED_PROVIDERS` in
   `src/routes/auth.js`.

No other code needs to change — routing, tenant resolution, and token
issuance are provider-agnostic.

## Swapping the in-memory store for a real database

`src/models/db.js`, `Tenant.js`, `User.js`, `Customer.js`, `Opportunity.js`,
`Job.js`, `Estimate.js`, `CatalogItem.js`, `EstimateTemplate.js`,
`RolePermissions.js`, `RefreshToken.js`, and `TokenBlocklist.js` are the
only files that know data is in-memory. Replace their internals with calls
to your ORM/driver of choice (Prisma, Sequelize, a raw driver, etc.) while
keeping the same method signatures, and nothing else in the app has to
change. `RefreshToken` in particular should map cleanly to a real table
(`tokenHash`, `tenantId`, `userId`, `expiresAt`, `revoked`); `TokenBlocklist`
maps well to a Redis set with per-key TTL if you'd rather not use your
primary DB for it. `RolePermissions` maps to a simple table keyed on
`(tenantId, role)` with a `permissions` JSON/array column. `Estimate.lineItems`
is stored as an embedded array (JSON column, or a document-DB subdocument)
rather than a separate table — line items are always read/written together
with their parent estimate and never queried independently, so normalizing
them out would just add joins for no benefit; if you do move to a
relational DB, a JSONB column (Postgres) is the natural fit, or a proper
child table if you later need to query across line items directly (e.g.
"total spent on mulch across all estimates").

## Notes / things to harden before production

- Tenant creation (`POST /tenants`) is wide open — gate it behind an admin
  role or invite flow.
- Add rate limiting on `/auth/*`, especially `/auth/refresh` and
  `/auth/logout`.
- The OAuth `state` param here only carries `tenantId` — for CSRF
  protection in production, also include and verify a per-request nonce.
- Permission overrides are validated against the known permission catalog,
  but there's no audit log of who changed a role's permissions or when --
  worth adding if this ever governs something regulated.
- Customers/opportunities are visible tenant-wide to anyone with read
  access; there's no per-record ownership/assignment scoping (e.g. "reps
  can only see their own accounts"). Add a `assignedTo` field and filter by
  it in the repository if you need that.
- Invite emails aren't actually sent anywhere yet — `POST
  /tenants/:id/members/invite` just creates the pending record; wire up an
  email provider to notify the invitee.
- **Add rate limiting on `/public/estimates/*`.** The `shareToken` is a
  bearer secret (unguessable, but still a secret) and this is otherwise a
  fully public, unauthenticated surface — rate limit it the same way you
  would `/auth/refresh`.
- **No file/photo upload storage is wired up.** `Job.photos` stores plain
  `{url, caption}` references; nothing in this app uploads or hosts the
  image itself. Point it at S3/Cloudinary/etc. from your frontend/upload
  endpoint.
- **No PDF generation.** The public link and `?view=customer` return
  structured data a frontend renders; if you want an actual downloadable
  PDF, add a library (e.g. `pdfkit`/`puppeteer`) and generate it from the
  same `buildCustomerView()` output rather than duplicating the sanitization
  logic.
- **Estimates/jobs are hard-deleted on cascade** (customer or tenant
  deletion) the same way customers/opportunities already are in this app.
  That's consistent with the rest of the codebase, but financial records
  (an approved estimate a customer signed off on) are exactly the kind of
  thing a real deployment often needs to retain for compliance/audit
  purposes — consider soft-deleting or archiving jobs/estimates instead of
  hard-deleting them before this goes to production.
- **Nothing automatically flips a stale estimate to `expired`.** `GET`
  requests deliberately never mutate state (see `isPastValidity()` in
  `models/Estimate.js`), so a draft/sent estimate past its `validUntil`
  shows as "past validity" in any view but keeps its real stored status
  until a staff member calls `POST` a manual expire action, or a scheduled
  job is added to sweep for + call it in bulk.
- **One shared catalog per tenant, not per-user/per-rep.** Simpler to keep
  accurate for a small shop; if you later support larger teams that want
  different regional cost lists, `CatalogItem` would need a scope field
  (e.g. `branchId`) and the repository/routes would need to filter by it.
- The in-memory `TokenBlocklist` and `refreshTokens` map never get swept —
  fine for a demo, but a real deployment should periodically purge expired
  entries (or rely on TTLs if you move this to Redis).
