# TRIVON Authentication and Authorization API

Express and MySQL service for authentication, access-token sessions, and reusable authorization checks for a multi-seller platform. It includes seller onboarding and seller-user lifecycle endpoints; it does not implement e-commerce features or platform staff administration.

## Implemented routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Service health check |
| `POST` | `/auth/sellers/register` | Public seller onboarding; creates an active account with `PENDING` verification |
| `POST` | `/auth/login` | Authenticate one typed account and issue tokens |
| `POST` | `/auth/refresh` | Rotate a refresh token and issue a new access token |
| `POST` | `/auth/logout` | Revoke the refresh-token session and its access tokens |
| `GET` | `/auth/me` | Return the currently authenticated account |
| `POST` | `/auth/seller-users` | Create a user for the authenticated, verified seller |
| `GET` | `/auth/seller-users` | List users belonging to the authenticated, verified seller |
| `PATCH` | `/auth/seller-users/:userId/active` | Activate/deactivate one user within that seller |

Account types are `SUPER_ADMIN`, `ADMIN`, `ACCOUNTANT`, `SELLER`, `CUSTOMER_CARE`, and `SELLER_USER`. Login requires `userType` and email. `sellerId` is required for `SELLER_USER` and rejected for other account types. Email is trimmed and lowercased. Seller-user lookup is always scoped to both seller ID and email.

Seller self-registration is available from the PDF's onboarding rule. It accepts name, email, password, business name, and optional mobile/GST identifiers. It creates a seller and one `PENDING` verification record in one transaction. It does not accept document URLs, grant roles, or return tokens; the seller logs in separately. Duplicate seller email/GST conflicts return a generic `409`.

```json
POST /auth/sellers/register
{
  "name": "Example Seller",
  "email": "seller@example.com",
  "password": "provided-by-the-seller",
  "businessName": "Example Store"
}
```

The successful response has `{ "user": { "id": "...", "userType": "SELLER", "sellerId": "...", "verificationStatus": "PENDING" } }`.

Seller-user creation and status management require a `SELLER` account with `APPROVED` verification. The seller ID comes from the authenticated account and is included in every account query. The request cannot select another seller. Newly created seller users receive no roles; role assignment remains disabled until its authority and scope are approved.

Example login request:

```json
{
  "userType": "SELLER_USER",
  "sellerId": "17",
  "email": "buyer@example.com",
  "password": "provided-by-the-user"
}
```

Successful login returns `accessToken`, `tokenType`, `expiresIn`, `refreshToken`, and a public `user` object. Use the access token as `Authorization: Bearer <accessToken>`.

Refresh and logout requests use the current refresh token:

```json
{ "refreshToken": "<opaque-refresh-token>" }
```

Refresh rotates the submitted token. Reuse of a rotated token revokes the entire session. Logout revokes all refresh and access-token rows for that session. Access requests check the JWT and the matching token row, so logout is enforced immediately for requests using this service's authentication middleware. No claim is made about revocation in other services that validate JWTs without checking `jwt_tokens`.

## Local setup

Requirements: Node.js 20 or newer, npm, and MySQL 8.0.16 or newer. Install from the committed lockfile:

```sh
npm ci
```

Create a private `.env` from `.env.example`. Set real local database values and a randomly generated `JWT_ACCESS_SECRET` of at least 32 bytes. Do not commit `.env` or use the example values as production credentials.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Runtime environment |
| `PORT` | HTTP port, defaults to `3000` |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection settings |
| `JWT_ACCESS_SECRET` | HS256 signing secret, required and at least 32 bytes |
| `JWT_ISSUER`, `JWT_AUDIENCE` | JWT issuer and audience; documented defaults are in `.env.example` |
| `JWT_ACCESS_TTL_SECONDS` | Access lifetime; defaults to 900 seconds and is limited to 60-3600 |
| `REFRESH_TOKEN_TTL_SECONDS` | Refresh lifetime; defaults to 604800 seconds and is limited to 3600-2592000 |
| `BCRYPT_WORK_FACTOR` | Password hashing cost; defaults to 12 and is limited to 10-15 |

Start the API with `npm start`. Database connections are opened lazily by routes and use a shared `mysql2/promise` connection pool.

## Database commands

`npm run db:check` executes `SELECT 1` and closes its pool. `npm run db:migrate:status` displays pending/applied migrations and checks recorded checksums. Neither command creates application tables.

The migration runner does not drop or replace tables. Before running it, verify that `.env` points to the intended disposable development database and inspect status. It stops when it finds untracked application tables, a migration checksum mismatch, or database migrations whose source files are missing from this checkout. MySQL DDL is not transactional; if a connection fails partway through a migration, inspect the database before retrying.

After checking `DB_NAME` and the migration status, explicitly enable migration execution:

```powershell
$env:ALLOW_SCHEMA_MIGRATIONS = 'true'
npm.cmd run db:migrate
Remove-Item Env:\ALLOW_SCHEMA_MIGRATIONS
```

The current schema is provisional. Review [the schema decisions](docs/architecture-decisions.md) and obtain the listed team decisions before applying it to shared or production data.

## Initial Super Admin

After applying the reviewed schema to a development database, run `npm run auth:bootstrap-super-admin` from an interactive terminal and confirm the displayed database name. The command verifies the connected database matches `DB_NAME`, obtains a MySQL advisory lock, refuses to proceed if a Super Admin already exists, prompts for name/email, and reads the password without echoing it. It never accepts a password on the command line or prints the password/hash. The bootstrap creates only the initial account; there is no public Super Admin registration route.

Creating a Super Admin does not automatically assign permissions. No roles or permissions are seeded, and platform staff management and an approved role-assignment workflow remain unimplemented. Protected operations using `requirePermission()` deny access until an approved role assignment and permission exist.

## Authentication and authorization behavior

- Passwords use `bcryptjs` with a work factor of 12 by default. Login rejects passwords above bcrypt's 72-byte input limit.
- Access tokens are HS256 JWTs, default lifetime 15 minutes, with issuer, audience, subject, account type, seller context, session ID, JWT ID, issued-at, and expiry claims. Signature, expiry, issuer, audience, algorithm, and required claims are validated.
- Refresh tokens contain 32 random bytes encoded as base64url. Only SHA-256 hashes are stored in MySQL. Tokens rotate on refresh; reuse revokes the session.
- Access JWT hashes, expiry, and revocation are stored in `jwt_tokens`; access middleware checks that row on each request. Refresh hashes, expiry, and rotation/revocation state are stored in `refresh_tokens`.
- Inactive accounts cannot log in or use access tokens. Seller accounts can authenticate for onboarding. Seller-user management applies `requireSellerOwner()`, `requireSellerTenant()`, and `requireSellerVerified()`; the latter allows only `APPROVED` sellers. No commerce-resource or verification-review routes are exposed.
- `requirePermission(name)` resolves the effective permission from MySQL on the server. Missing assignments deny with `403`; the client cannot supply identity, role, permission, or trusted seller context.
- Login is limited to 10 attempts per IP per 15 minutes using an in-memory limiter. For multi-instance deployments, configure an approved shared rate-limit store before relying on a cluster-wide threshold.
- Seller self-registration is limited to 5 attempts per IP per 15 minutes with the same in-memory limitation.
- Helmet is enabled. JSON bodies are limited to 10 KB. There is no permissive CORS configuration.

Refresh tokens are currently returned in JSON and accepted in JSON request bodies. A browser-specific `HttpOnly` cookie and CSRF strategy has not been approved or implemented; client storage policy remains a deployment decision.

Expired and revoked token rows are retained so refresh-token reuse can be detected; automated retention cleanup is not implemented.

## Errors

Errors use `{ "error": { "code": "...", "message": "..." } }`. Invalid fields return `400`, unauthenticated requests return `401`, denied permissions/tenant access return `403`, oversized bodies return `413`, unknown paths return `404`, and unavailable database/auth services return a generic `503`. SQL text, stack traces, password values, and token values are not returned.

## Tests

Run the built-in Node.js test suite with `npm test`. It uses mocked database interactions and ephemeral HTTP servers; it does not require MySQL. Live database integration has not been run in this environment. Configure an isolated test database before adding integration tests; never point tests at production data.

## Current limits and team decisions

The migration and session model encode documented provisional decisions. Global account role assignment, seller role scope, seller verification reviewer permissions/history, seller creator references, and verification-state policy still need product/team confirmation. Seller self-registration and verified seller-user create/list/status management are implemented. Creating/managing platform staff, verification review, role/permission administration, and address CRUD endpoints are not implemented. See [architecture decisions](docs/architecture-decisions.md) and [schema review](docs/schema-review.md) before treating this service as ready for shared or production use.
