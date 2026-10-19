# Proposed database schema review

This review is based on the October 2026 schema PDF. The proposal contains 14 tables and allows identifiers to use UUID or BIGINT consistently. It describes a current verification record per seller, seller-user roles, central roles and permissions, and separate refresh-token and JWT tracking tables.

## Proposed tables

| Area | Tables |
| --- | --- |
| Accounts | `super_admins`, `admins`, `accountants`, `sellers`, `customer_care`, `seller_users` |
| Seller/user data | `seller_verifications`, `user_addresses` |
| Authorization | `seller_user_roles`, `roles`, `permissions`, `role_permissions` |
| Tokens | `refresh_tokens`, `jwt_tokens` |

The proposal says Super Admin has no public registration; Admin can manage only assigned privileges; a Seller owns tenant-scoped Seller Users; and all protected seller resources must enforce the authenticated seller context. Seller-user email uniqueness is `UNIQUE(seller_id, email)`. The current seller verification row is unique by seller.

## Relationships and gaps

- `admins.created_by` and `accountants.created_by` reference `super_admins.id`.
- `seller_users.seller_id` references `sellers.id`; `user_addresses.user_id` references `seller_users.id`.
- `seller_verifications.seller_id` references `sellers.id` and is unique for the current record.
- `seller_user_roles` links seller users to roles; `role_permissions` links roles to permissions.
- `sellers.created_by` plus `created_by_type` and `seller_verifications.reviewed_by` are polymorphic references in the proposal. Ordinary foreign keys cannot validate them against multiple account tables.
- Token `user_id` plus `user_type` is polymorphic for the same reason. The account type must be a strict allowlist.
- Global account categories have no role-assignment table in the PDF. The PDF calls six account categories “roles” in its summary but only provides a seller-user role mapping table.
- `sellers.verification_status` duplicates the current `seller_verifications.verification_status` value. The source of truth and synchronization policy need agreement.
- The token tables overlap in lifecycle metadata. `jwt_tokens` includes refresh expiry and access-token revocation; `refresh_tokens` includes token expiry and revocation. Session identity, rotation, and replay behavior need clear ownership.
- One current verification row does not preserve review history or prior rejection/document metadata after resubmission.
- `roles` in the PDF has no scope/tenant owner field, so seller-defined role isolation is not expressed.

## Migration readiness

The current initial migration uses `BIGINT UNSIGNED AUTO_INCREMENT`, adds role scope and `global_account_roles`, records reviewer type, and adds session IDs to both token tables. These are provisional additions, not approved changes to the PDF. The migration retains the 14 proposed tables and additionally creates `global_account_roles`; the schema decision record explains each addition. No live database has been inspected or modified.

The SQL includes no `DROP` or overwrite operations. The runner tracks ordered migration names/checksums and stops on existing untracked target tables, checksum mismatches, unknown applied migrations, or per-migration table conflicts. MySQL DDL can partially apply if a connection fails; inspect the database manually before retrying after an interrupted migration.
