# Provisional architecture decisions

This record supports implementation work while retaining the schema PDF as the approved proposal. Choices marked provisional are not team approvals. The migration must not be applied to a shared or production database until the outstanding decisions below are accepted.

## Provisional technical choices in the initial migration

### Identifiers

Use `BIGINT UNSIGNED AUTO_INCREMENT` for every account, role, permission, token, and dependent-table primary/foreign key. This avoids mixing the proposal's UUID/BIGINT alternatives and is straightforward for a single MySQL deployment. Numeric IDs are serialized to API/JWT strings to avoid JavaScript integer precision issues. **Confirmation required:** deployment/ID generation strategy and exposure of sequential IDs.

### Login identity

Require the account type and email for every login. Require `sellerId` for `SELLER_USER` because `(seller_id, email)` is the approved uniqueness rule. Normalize login email by trimming and lowercasing. Table selection uses a fixed allowlist. Seller-user lookup always includes both seller ID and email. **Confirmation required:** confirm `userType` naming and normalization policy, plus whether email may collide across global account tables.

### Passwords

Use bcrypt through `bcryptjs`, work factor 12 by default, and enforce bcrypt's 72-byte input limit. Unknown accounts still perform a dummy hash comparison; inactive or invalid accounts receive the same generic 401 credential response. Password policy and cost can be reviewed before deployment. No plaintext password is stored or logged.

### Access and refresh sessions

- Sign HS256 access JWTs with a required `JWT_ACCESS_SECRET` of at least 32 bytes. Defaults: 15-minute access lifetime, explicit issuer/audience, strict algorithm verification.
- Generate opaque refresh tokens from 32 random bytes and persist only their SHA-256 hash.
- Use `jwt_tokens` for access-token hash, expiry, and revocation checks. The authentication middleware performs a row lookup per protected request, allowing logout to immediately invalidate access through this service.
- Use `refresh_tokens` for opaque refresh hash, expiry, and rotation/revocation. Rotate on refresh. If a revoked token is reused, revoke every token in that session.
- Add the same random `session_id` to both tables so logout and reuse handling can revoke one session. Continue recording `jwt_tokens.refresh_token_expires_at` from the paired refresh token because it is in the PDF proposal; `jwt_tokens` does not store raw refresh material.
- Store SHA-256 hex digests in `CHAR(64)` columns rather than the proposal's `VARCHAR(500)` token-hash fields. This makes the stored representation match the fixed digest format.

The PDF does not explain why both token tables are needed or define session/replay semantics. **Confirmation required:** approve or replace the dual-table ownership, immediate revocation requirement, refresh expiry, session scope, rotation, and reuse policy. If services outside this API validate JWTs without consulting `jwt_tokens`, logout does not revoke those copies until their JWT expires.

### Role and permission mapping

Keep identity category separate from authorization role. Preserve `seller_user_roles` for tenant users. Add `roles.scope_type` (`GLOBAL` or `SELLER`) and `global_account_roles` for global account categories because the PDF has no global assignment mapping. Do not seed roles or permissions. `requirePermission()` looks up the assignment server-side and denies when none exists; it grants no automatic Super Admin/Admin privileges.

The added table cannot have a normal FK to each of five account tables; `user_type` is allowlisted and the reference is documented as polymorphic. Seller role definitions are global to the service at present; assignments remain user-specific and scoped to the authenticated seller. **Confirmation required:** who may assign roles, whether seller roles are shared or seller-defined, which account categories have roles, and how multiple role grants combine. Platform-staff and role-management routes remain disabled until these are approved. Seller-user lifecycle routes are limited to an authenticated `SELLER` account whose verification is `APPROVED`, matching the proposal's seller-owned account rule.

### Verification and reviewer identity

Treat the seller's verification status as the current access gate and require `APPROVED` for seller-user management. Permit seller authentication for onboarding. Seller self-registration creates one `PENDING` verification row. Add `reviewed_by_type` constrained to `SUPER_ADMIN` or `ADMIN` because `reviewed_by` alone cannot identify a row across account tables. Keep one current verification row, matching the PDF uniqueness constraint; no review/history endpoints are implemented.

The PDF does not define pending/rejected access, reviewer permissions, resubmission history, or synchronization between the status on `sellers` and `seller_verifications`. **Confirmation required:** approve this limited gate and define verification transitions/reviewer roles/history/source of truth before adding onboarding or review endpoints.

### Creator and account references

Use real foreign keys for ordinary same-table relationships. `sellers.created_by` and token/global-role `user_id` cannot have conventional foreign keys across separate account tables; accepted `*_type` values are strict enums/allowlists, and application queries resolve the identified table. For verification, `reviewed_by_type` is an additive discriminator. Seller-user `created_by` references the seller that owns the account, as stated by the PDF.

### Migration policy

The initial migration preserves the 14 proposed table names and constraints, plus one provisional `global_account_roles` table. It contains no destructive DDL. Migration execution requires `ALLOW_SCHEMA_MIGRATIONS=true`, checks the active database's tables and recorded checksums, and stops on conflicts. Because MySQL DDL may partially apply, an interrupted migration requires manual inspection before retry. The environment currently has no `.env` credentials and no available MySQL installation/service; no live database was inspected or modified.

## Decisions still required from the project team

1. Approve `BIGINT UNSIGNED` or select UUID and its storage format.
2. Confirm login field name, email normalization/case policy, cross-table email collisions, and seller-user tenant selection.
3. Decide whether to retain both token tables and approve lifetimes, session scope, immediate revocation, rotation, and reuse handling.
4. Approve global role assignment, seller role scope, multiple-role behavior, and who may grant/revoke roles and permissions.
5. Define permissions for every account-management operation. No broad default privilege is granted.
6. Define seller verification reviewers, transition permissions, whether pending/rejected sellers can access onboarding, status source of truth, and history/resubmission retention.
7. Confirm seller creation authority and polymorphic creator reference behavior.
8. Approve where browser clients store refresh tokens and the CSRF strategy if cookies are selected.

Until these decisions are made, login/session mechanics, seller self-registration, and verified seller-owner management of that owner's seller users are implemented behind the provisional schema. Seller registration creates a `PENDING` verification record and grants no role; seller-user creation also grants no role. Platform staff management, verification review, role assignment, and address CRUD are not implemented.
