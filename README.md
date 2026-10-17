# TRIVON Authentication and Authorization API

## Purpose and scope

This service is the planned identity and access-control API for TRIVON's multi-seller platform. The current implementation is a small Express foundation with a health endpoint. MySQL configuration is prepared for later use; authentication, authorization, database queries, and tenant enforcement are not implemented yet.

## Technology stack

- Node.js with ES modules
- Express.js
- MySQL through `mysql2`
- `dotenv` for local environment configuration
- `helmet` for HTTP security headers
- Node.js built-in test runner

## Prerequisites

- Node.js 20 or newer (the built-in test runner and `fetch` are used)
- npm
- MySQL is only needed when database-backed features are implemented. Tests and the current server do not require a MySQL server.

## Install

From the project directory, install the dependencies listed in the lockfile:

```sh
npm ci
```

## Configure environment

Copy `.env.example` to `.env` and replace the safe example values with local settings when needed. Keep `.env` private and never commit it. The current server reads `NODE_ENV`/`PORT` through dotenv; `src/config/database.js` reads database settings only when its pool factory is called.

| Variable | Purpose | Example |
| --- | --- | --- |
| `NODE_ENV` | Runtime environment | `development` |
| `PORT` | HTTP listen port | `3000` |
| `DB_HOST` | MySQL host | `localhost` |
| `DB_PORT` | MySQL port | `3306` |
| `DB_USER` | MySQL user | `your_mysql_user` |
| `DB_PASSWORD` | MySQL password | `your_mysql_password` |
| `DB_NAME` | MySQL database name | `trivon_auth` |

The app does not open or verify a database connection at startup. The database module exports a pool factory for future route/service code to call after configuration is available.

## Run

```sh
npm start
```

For automatic restarts during development:

```sh
npm run dev
```

The server listens on port `3000` by default. Set `PORT` to use another port.

## Test

```sh
npm test
```

Tests use ephemeral loopback ports and the built-in `node:test` runner. They do not need MySQL.

## Available endpoint

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health` | `200` with `{"status":"ok"}` |

Unknown paths return `404` with `{ "error": { "code": "NOT_FOUND", "message": "Route not found" } }`.

## Current implementation status

- Express app, server entry point, Helmet configuration, and JSON parsing are in place.
- `GET /health` and the unknown-route response are implemented and covered by tests.
- A MySQL pool factory is prepared, but it has not been verified against a running MySQL server and is not used by the app yet.
- The proposed schema is documented in `docs/`; there are no migrations or tables in this repository.
- Login, password verification, JWT issuance, refresh sessions, logout, RBAC, account management, and seller tenant isolation are not implemented.

## Planned development phases

1. Confirm the open schema decisions recorded in `docs/schema-review.md`.
2. Finalize and implement the database schema through reviewed migrations.
3. Verify MySQL connectivity and add a repository/service data-access layer.
4. Implement account lifecycle and authentication flows.
5. Implement access-token and refresh-session handling.
6. Implement role/permission authorization and enforce seller-level tenant isolation.
7. Expand integration tests and API documentation as endpoints are added.

## Security practices

- Store password hashes, never plaintext passwords.
- Keep credentials in local environment configuration and out of source control.
- Use parameterized SQL for all database queries.
- Validate inputs and return consistent errors.
- Derive seller scope from authenticated identity and verify it against every tenant-owned resource.
