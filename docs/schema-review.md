# Database schema review

## Overview

The October 2026 schema PDF proposes 14 tables for platform and seller identities, seller onboarding and verification, seller-user addresses, roles and permissions, and token/session tracking. The document says IDs should use UUID or BIGINT consistently. This review records the proposal and risks; it does not change the approved design or create tables.

## Main table groups

- **Platform and tenant accounts:** `super_admins`, `admins`, `accountants`, `sellers`, and `customer_care` hold distinct account categories. `seller_users` holds users scoped to one seller.
- **Seller onboarding:** `seller_verifications` stores MSME/GST document references and the verification outcome. `sellers` also carries a verification status.
- **Seller-user data:** `user_addresses` stores multiple addresses for a seller user.
- **Authorization:** `roles` and `permissions` define access; `role_permissions` links them; `seller_user_roles` assigns roles to seller users.
- **Sessions and tokens:** `refresh_tokens` stores hashed refresh tokens and revocation data. `jwt_tokens` appears to track access and refresh lifecycle metadata.

## Keys and relationships described

- `admins.created_by` and `accountants.created_by` reference `super_admins.id`.
- `sellers.created_by` plus `created_by_type` point to either a super admin or admin, depending on type.
- `seller_users.seller_id` references `sellers.id`; `(seller_id, email)` must be unique.
- `user_addresses.user_id` references `seller_users.id`.
- `seller_verifications.seller_id` references `sellers.id`; the PDF calls for a unique seller ID for the current verification record.
- `seller_user_roles.seller_user_id` references `seller_users.id` and `role_id` references `roles.id`; the pair is unique.
- `role_permissions.role_id` references `roles.id` and `permission_id` references `permissions.id`; the pair is unique.
- Token rows carry `user_id`, `user_type`, and optional `seller_id`, but the account-table references are polymorphic rather than ordinary foreign keys.

## Seller-level isolation requirements

Treat `seller_id` as trusted server-side context derived from the authenticated identity. For every seller-owned read or write, the service must scope the operation by that tenant and verify the resource belongs to it. A client-provided seller ID must not allow switching tenants. Role assignment and address operations must likewise be checked against the seller-user's owning seller. These are requirements from the schema document, not implemented behavior in the current app.

## Decisions to confirm before migrations

1. **`refresh_tokens` and `jwt_tokens`:** Decide whether both tables are needed. The refresh table supports revocable sessions; the JWT table duplicates some expiry/revocation data and has `refresh_token_expires_at`, so ownership and lifecycle responsibilities are unclear. A stateless access JWT may not need a row per token unless immediate revocation or audit is required.
2. **`user_id` plus `user_type`:** Define the accepted `user_type` enum/values, how IDs map to six separate account tables, and how referential integrity, deletion, and account type changes are handled. Prefer a shared identity/sessions model only if the project lead approves a design change; do not assume it here.
3. **`sellers.created_by`:** Confirm allowed creator types, whether `ADMIN` is always allowed to create sellers, and how to enforce that the creator ID exists in the table named by `created_by_type`. A conventional FK cannot enforce this polymorphic reference.
4. **`seller_verifications.reviewed_by`:** Confirm which account categories may review, how reviewer type is represented, and whether the reviewer must be a global administrator. The current column alone cannot identify a row among multiple account tables safely.
5. **Verification history:** The PDF says one current verification row per seller while also recording timestamps and rejection details. Decide whether resubmissions overwrite that row or create an auditable history, and how old documents and decisions are retained.
6. **Global and tenant roles:** `seller_user_roles` only assigns roles to seller users. Confirm how admins, accountants, customer-care staff, super admins, and sellers receive roles/permissions, and whether `roles` are global, seller-defined, or both. Define uniqueness and role scope accordingly.
7. **Identifier type:** Select UUID or BIGINT before schema creation and apply it consistently to PKs, FKs, and polymorphic IDs. Also confirm UUID storage format if selected.

## Potential inconsistencies and implementation risks

- The PDF's overview table inventory numbers and categories do not match the detailed table numbering; use the detailed 14-table definitions as the current inventory pending confirmation.
- `sellers.verification_status` and `seller_verifications.verification_status` duplicate state. Define the source of truth and update consistency rules.
- The token tables overlap, and `jwt_tokens.refresh_token_expires_at` sits alongside `refresh_tokens`; this can create conflicting expiry and revocation state.
- `jwt_tokens.token_type` is described as a bearer type while the table is also framed as JWT/session tracking. Confirm whether this column means token class, signing format, or something else.
- The schema says “6 Roles” in a summary, but the six account categories are not all linked to the central `roles` table. Clarify whether those are account types or authorization roles.
- The PDF lists a unique `seller_verifications.seller_id` for the current record; if history is required, that uniqueness must instead be modeled around current status/versioning.
- The seller email and GST uniqueness notes are conditional business rules. Confirm normalization/case behavior and whether uniqueness is global before applying indexes.
- `seller_users.created_by` is described as a seller FK, but the exact intended reference (the owning seller versus the seller account that created the user) should be confirmed.

No migrations or database tables were created during this review.
