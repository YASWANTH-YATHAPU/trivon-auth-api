import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { AccountService } from '../src/auth/account-service.js';
import { AuthService } from '../src/auth/auth-service.js';
import { AuthError, invalidCredentialsError } from '../src/auth/errors.js';
import { passwordHasher } from '../src/auth/passwords.js';
import {
  createAuthenticationMiddleware,
  requirePermission,
  requireSellerTenant,
  requireSellerVerified,
} from '../src/auth/middleware.js';
import { createSessionId, issueAccessToken, verifyAccessToken } from '../src/auth/tokens.js';
import { createAuthRouter } from '../src/routes/auth.js';

const env = {
  JWT_ACCESS_SECRET: 'unit-test-signing-secret-that-is-longer-than-32-bytes',
  JWT_ISSUER: 'trivon-test',
  JWT_AUDIENCE: 'trivon-test-api',
  JWT_ACCESS_TTL_SECONDS: '900',
  REFRESH_TOKEN_TTL_SECONDS: '604800',
};

const allowThrough = (req, res, next) => next();

async function startServer(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function appFor({ getService = () => ({}), getAccountService = () => ({}), authenticate = allowThrough, pool = { query: async () => [[], []] } } = {}) {
  return createApp({
    databasePoolProvider: () => pool,
    authRouter: createAuthRouter({ getService, getAccountService, authenticate, limiter: allowThrough, registrationLimiter: allowThrough }),
  });
}

test('POST /auth/login validates and normalizes the login identifier before calling the service', async () => {
  let received;
  const server = await startServer(appFor({
    getService: () => ({ login: async (input) => { received = input; return { accessToken: 'access', refreshToken: 'refresh' }; } }),
  }));
  try {
    const response = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userType: 'ADMIN', email: '  ADMIN@EXAMPLE.COM ', password: 'test-password' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, { userType: 'ADMIN', email: 'admin@example.com', password: 'test-password' });
    assert.deepEqual(await response.json(), { accessToken: 'access', refreshToken: 'refresh' });
  } finally {
    await server.close();
  }
});

test('POST /auth/login rejects missing or unsupported account types and malformed fields', async () => {
  let serviceCalls = 0;
  const server = await startServer(appFor({ getService: () => ({ login: async () => { serviceCalls += 1; } }) }));
  try {
    const invalidBodies = [
      { email: 'a@example.com', password: 'password' },
      { userType: 'OWNER', email: 'a@example.com', password: 'password' },
      { userType: 'ADMIN', email: 'not-an-email', password: 'password' },
      { userType: 'ADMIN', email: 'a@example.com', password: 'x'.repeat(73) },
      { userType: 'ADMIN', email: 'a@example.com', password: 'password', sellerId: '1' },
      { userType: 'SELLER_USER', email: 'a@example.com', password: 'password' },
      { userType: 'SELLER_USER', email: 'a@example.com', password: 'password', sellerId: 'not-an-id' },
      { userType: 'SELLER_USER', email: 'a@example.com', password: 'password', sellerId: '18446744073709551616' },
    ];
    for (const body of invalidBodies) {
      const response = await fetch(`${server.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
    }
    assert.equal(serviceCalls, 0);
  } finally {
    await server.close();
  }
});

test('POST /auth/login rate-limits repeated attempts', async () => {
  const server = await startServer(createApp());
  try {
    let lastResponse;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      lastResponse = await fetch(`${server.baseUrl}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userType: 'ADMIN', email: 'bad@example.com', password: 'wrong-password' }),
      });
    }
    assert.equal(lastResponse.status, 429);
    assert.equal((await lastResponse.json()).error.code, 'RATE_LIMITED');
  } finally {
    await server.close();
  }
});

test('POST /auth/sellers/register creates a pending seller without returning password data', async () => {
  let received;
  const server = await startServer(appFor({
    getAccountService: () => ({ registerSeller: async (input) => {
      received = input;
      return { user: { id: '52', userType: 'SELLER', email: input.email, sellerId: '52', verificationStatus: 'PENDING' } };
    } }),
  }));
  try {
    const response = await fetch(`${server.baseUrl}/auth/sellers/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '  New Seller ', email: ' SELLER@EXAMPLE.COM ', password: 'registration-password',
        businessName: '  Example Business ', gstId: ' abc123 ',
      }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(received, {
      name: 'New Seller', email: 'seller@example.com', password: 'registration-password',
      businessName: 'Example Business', gstId: 'ABC123',
    });
    const body = await response.json();
    assert.equal(body.user.verificationStatus, 'PENDING');
    assert.equal(JSON.stringify(body).includes('registration-password'), false);
  } finally {
    await server.close();
  }
});

test('public seller registration has its own rate limit', async () => {
  const server = await startServer(createApp());
  try {
    let lastResponse;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      lastResponse = await fetch(`${server.baseUrl}/auth/sellers/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Seller', email: `seller${attempt}@example.com`, password: 'registration-password', businessName: 'Store' }),
      });
    }
    assert.equal(lastResponse.status, 429);
    assert.equal((await lastResponse.json()).error.code, 'RATE_LIMITED');
  } finally {
    await server.close();
  }
});

test('seller registration rejects invalid fields and hides duplicate/database details', async () => {
  let serviceCalls = 0;
  const server = await startServer(appFor({
    getAccountService: () => ({ registerSeller: async () => { serviceCalls += 1; throw { code: 'ER_DUP_ENTRY' }; } }),
  }));
  try {
    for (const body of [
      { name: 'Seller', email: 'bad', password: 'registration-password', businessName: 'Store' },
      { name: 'Seller', email: 'seller@example.com', password: 'short', businessName: 'Store' },
      { name: 'Seller', email: 'seller@example.com', password: 'registration-password', businessName: 'Store', role: 'ADMIN' },
    ]) {
      const response = await fetch(`${server.baseUrl}/auth/sellers/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(serviceCalls, 0);

    const conflict = await fetch(`${server.baseUrl}/auth/sellers/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Seller', email: 'seller@example.com', password: 'registration-password', businessName: 'Store' }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(JSON.stringify(await conflict.json()).includes('ER_DUP_ENTRY'), false);
  } finally {
    await server.close();
  }
});

test('AccountService hashes seller password and creates a pending verification row in one transaction', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push(['BEGIN']),
    commit: async () => calls.push(['COMMIT']),
    rollback: async () => calls.push(['ROLLBACK']),
    release: () => calls.push(['RELEASE']),
    query: async (sql, values) => {
      calls.push([sql, values]);
      if (sql.includes('INSERT INTO sellers')) return [{ insertId: '52' }, []];
      return [{ affectedRows: 1 }, []];
    },
  };
  const service = new AccountService({ pool: { getConnection: async () => connection }, hasher: { hash: async (password) => `hash:${password}` } });
  const result = await service.registerSeller({
    name: 'Seller', email: 'seller@example.com', password: 'registration-password', businessName: 'Store', gstId: null,
  });
  assert.equal(result.user.id, '52');
  assert.equal(result.user.verificationStatus, 'PENDING');
  assert.ok(calls.some(([sql, values]) => sql.includes('INSERT INTO seller_verifications') && values[0] === '52'));
  assert.ok(calls.some(([sql, values]) => sql.includes('INSERT INTO sellers') && values[3] === 'hash:registration-password'));
  assert.ok(!calls.some(([, values]) => values?.includes('registration-password')));
  assert.ok(calls.some(([sql]) => sql === 'COMMIT'));
});

test('verified sellers manage only users bound to their authenticated seller ID', async () => {
  const serviceCalls = [];
  const getAccountService = () => ({
    createSellerUser: async (sellerId, input) => {
      serviceCalls.push(['create', sellerId, input]);
      return { id: '22', sellerId, email: input.email, isActive: true };
    },
    listSellerUsers: async (sellerId) => {
      serviceCalls.push(['list', sellerId]);
      return [{ id: '22', sellerId, isActive: true }];
    },
    setSellerUserActive: async (sellerId, userId, isActive) => {
      serviceCalls.push(['status', sellerId, userId, isActive]);
      return userId === '22' ? { id: userId, isActive } : null;
    },
  });
  const authenticate = (req, res, next) => {
    req.auth = { userId: '17', userType: 'SELLER', sellerId: '17', account: { verificationStatus: 'APPROVED' } };
    next();
  };
  const server = await startServer(appFor({ getAccountService, authenticate }));
  try {
    const created = await fetch(`${server.baseUrl}/auth/seller-users`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'USER@EXAMPLE.COM', password: 'seller-user-password', firstName: 'User', lastName: 'One' }),
    });
    assert.equal(created.status, 201);
    assert.equal(serviceCalls[0][1], '17');
    assert.equal(serviceCalls[0][2].email, 'user@example.com');

    const listed = await fetch(`${server.baseUrl}/auth/seller-users`);
    assert.equal(listed.status, 200);
    assert.equal(serviceCalls[1][1], '17');

    const updated = await fetch(`${server.baseUrl}/auth/seller-users/22/active`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isActive: false }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(serviceCalls[2], ['status', '17', '22', false]);

    const crossTenant = await fetch(`${server.baseUrl}/auth/seller-users?sellerId=18`);
    assert.equal(crossTenant.status, 403);
    assert.equal(serviceCalls.length, 3);
  } finally {
    await server.close();
  }
});

test('AccountService scopes seller-user reads and writes by seller ID', async () => {
  const calls = [];
  const pool = {
    query: async (sql, values) => {
      calls.push([sql, values]);
      if (sql.startsWith('INSERT INTO seller_users')) return [{ insertId: '31' }, []];
      if (sql.startsWith('SELECT id, email')) return [[{ id: '31', isActive: 1 }], []];
      return [[], []];
    },
  };
  const service = new AccountService({ pool, hasher: { hash: async () => 'safe-hash' } });
  await service.createSellerUser('17', {
    email: 'user@example.com', password: 'seller-user-password', firstName: 'A', lastName: 'User',
  });
  await service.listSellerUsers('17');
  await service.setSellerUserActive('17', '31', false);

  assert.deepEqual(calls[0][1], ['17', 'user@example.com', null, 'safe-hash', 'A', 'User', '17']);
  assert.match(calls[1][0], /WHERE seller_id = \?/);
  assert.deepEqual(calls[1][1], ['17']);
  assert.match(calls[2][0], /WHERE id = \? AND seller_id = \?/);
  assert.deepEqual(calls[2][1], [false, '31', '17']);
  assert.match(calls[3][0], /WHERE id = \? AND seller_id = \?/);
  assert.deepEqual(calls[3][1], ['31', '17']);
});

test('seller-user management denies seller users and sellers pending verification', async () => {
  const cases = [
    { userType: 'SELLER_USER', verificationStatus: 'APPROVED' },
    { userType: 'SELLER', verificationStatus: 'PENDING' },
  ];
  for (const identity of cases) {
    const authenticate = (req, res, next) => {
      req.auth = { userId: '17', userType: identity.userType, sellerId: '17', account: { verificationStatus: identity.verificationStatus } };
      next();
    };
    const server = await startServer(appFor({ authenticate }));
    try {
      const response = await fetch(`${server.baseUrl}/auth/seller-users`);
      assert.equal(response.status, 403);
    } finally {
      await server.close();
    }
  }
});

test('POST /auth/login uses generic invalid-credential errors and hides database failures', async () => {
  const server = await startServer(appFor({
    getService: () => ({ login: async () => { throw invalidCredentialsError(); } }),
  }));
  try {
    const rejected = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userType: 'ADMIN', email: 'a@example.com', password: 'wrong' }),
    });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error.code, 'INVALID_CREDENTIALS');
  } finally {
    await server.close();
  }

  const unavailable = await startServer(appFor({ getService: () => ({ login: async () => { throw new Error('SQL password leak'); } }) }));
  try {
    const response = await fetch(`${unavailable.baseUrl}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userType: 'ADMIN', email: 'a@example.com', password: 'test-password' }),
    });
    assert.equal(response.status, 503);
    assert.equal(JSON.stringify(await response.json()).includes('SQL password leak'), false);
  } finally {
    await unavailable.close();
  }
});

test('POST /auth/login rejects seller-user accounts without seller context', async () => {
  const pool = {
    query: async (sql, parameters) => {
      assert.match(sql, /su\.seller_id = \?/);
      assert.deepEqual(parameters, ['person@example.com', '17']);
      return [[{
        id: 21, seller_id: 17, email: 'person@example.com', password_hash: 'stored-hash',
        first_name: 'Seller', last_name: 'User', is_active: 1, seller_is_active: 1,
        verification_status: 'PENDING', userType: 'SELLER_USER',
      }], []];
    },
    getConnection: async () => fakeConnection(),
  };
  const service = new AuthService({ pool, env, hasher: { hash: async () => 'dummy', compare: async () => true } });
  await assert.rejects(service.login({ userType: 'SELLER_USER', email: 'person@example.com', password: 'secret' }),
    (error) => error instanceof AuthError && error.status === 400);

  const server = await startServer(appFor({ getService: () => service }));
  try {
    const response = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userType: 'SELLER_USER', email: 'person@example.com', password: 'valid-password', sellerId: '17' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.sellerId, '17');
  } finally {
    await server.close();
  }
});

function fakeConnection({ loginAccount, refreshRecord } = {}) {
  const calls = [];
  const connection = {
    calls,
    beginTransaction: async () => calls.push(['BEGIN']),
    commit: async () => calls.push(['COMMIT']),
    rollback: async () => calls.push(['ROLLBACK']),
    release: () => calls.push(['RELEASE']),
    query: async (sql, values = []) => {
      calls.push([sql, values]);
      if (sql.includes('FROM refresh_tokens WHERE token_hash = ?')) return [[refreshRecord].filter(Boolean), []];
      if (sql.startsWith('SELECT id, email, password_hash, name') || sql.includes('FROM seller_users su')) {
        return [[loginAccount].filter(Boolean), []];
      }
      if (sql.startsWith('UPDATE refresh_tokens SET revoked_at') && sql.includes('WHERE id = ?')) return [{ affectedRows: 1 }, []];
      if (sql.startsWith('INSERT INTO')) return [{ insertId: 1 }, []];
      return [{ affectedRows: 1 }, []];
    },
  };
  return connection;
}

test('AuthService login verifies bcrypt abstraction, persists only hashes and updates last_login_at', async () => {
  const account = { id: 8, name: 'Admin', email: 'admin@example.com', password_hash: 'stored-hash', is_active: 1, userType: 'ADMIN' };
  const connection = fakeConnection({ loginAccount: account });
  const pool = { query: connection.query, getConnection: async () => connection };
  const service = new AuthService({
    pool, env,
    hasher: { hash: async () => 'dummy-hash', compare: async (password, hash) => password === 'correct-password' && hash === 'stored-hash' },
    clock: () => new Date('2026-10-19T10:00:00.000Z'),
  });
  const result = await service.login({ userType: 'ADMIN', email: 'admin@example.com', password: 'correct-password' }, { ip: '127.0.0.1', userAgent: 'test' });
  assert.equal(result.tokenType, 'Bearer');
  assert.equal(result.user.id, '8');
  const sqlCalls = connection.calls.filter(([sql]) => typeof sql === 'string');
  assert.ok(sqlCalls.some(([sql]) => sql.includes('UPDATE admins SET last_login_at')));
  assert.ok(sqlCalls.some(([sql, values]) => sql.includes('INSERT INTO jwt_tokens') && /^[a-f0-9]{64}$/.test(values[4])));
  assert.ok(sqlCalls.some(([sql, values]) => sql.includes('INSERT INTO refresh_tokens') && /^[a-f0-9]{64}$/.test(values[4])));
  assert.ok(!sqlCalls.some(([, values]) => values?.includes('correct-password')));
});

test('AuthService refuses inactive accounts and emits the same credential error', async () => {
  const connection = fakeConnection({ loginAccount: {
    id: 8, name: 'Admin', email: 'admin@example.com', password_hash: 'stored-hash', is_active: 0, userType: 'ADMIN',
  } });
  const service = new AuthService({ pool: { query: connection.query, getConnection: async () => connection }, env,
    hasher: { hash: async () => 'dummy-hash', compare: async () => true } });
  await assert.rejects(service.login({ userType: 'ADMIN', email: 'admin@example.com', password: 'test-password' }),
    (error) => error.status === 401 && error.code === 'INVALID_CREDENTIALS');
});

test('password hasher stores bcrypt hashes and compares without exposing plaintext', async () => {
  const password = 'a-long-enough-test-password';
  const hash = await passwordHasher.hash(password);
  assert.match(hash, /^\$2[aby]\$12\$/);
  assert.equal(await passwordHasher.compare(password, hash), true);
  assert.equal(await passwordHasher.compare('different-password', hash), false);
  assert.notEqual(hash, password);
});

test('AuthService rotates refresh tokens and revokes a session after token reuse', async () => {
  const account = { id: 8, name: 'Admin', email: 'admin@example.com', is_active: 1 };
  const oldRecord = {
    id: 3, session_id: 'a'.repeat(32), user_id: 8, user_type: 'SUPER_ADMIN', seller_id: null,
    expires_at: new Date(Date.now() + 3600000), is_unexpired: 1, revoked_at: null,
  };
  const connection = fakeConnection({ refreshRecord: oldRecord });
  connection.query = async (sql, values = []) => {
    connection.calls.push([sql, values]);
    if (sql.includes('FROM refresh_tokens WHERE token_hash = ?')) return [[{ ...oldRecord }], []];
    if (sql.startsWith('SELECT id, email, password_hash, name')) return [[account], []];
    if (sql.startsWith('UPDATE refresh_tokens SET revoked_at') && sql.includes('WHERE id = ?')) return [{ affectedRows: 1 }, []];
    if (sql.startsWith('INSERT INTO')) return [{ insertId: 1 }, []];
    return [{ affectedRows: 1 }, []];
  };
  const service = new AuthService({ pool: { getConnection: async () => connection }, env });
  const rotated = await service.refresh('old-refresh-token-value-that-is-long-enough', { ip: '127.0.0.1' });
  assert.equal(rotated.tokenType, 'Bearer');
  assert.notEqual(rotated.refreshToken, 'old-refresh-token-value-that-is-long-enough');
  assert.ok(connection.calls.some(([sql]) => sql.startsWith('UPDATE refresh_tokens SET revoked_at') && sql.includes('WHERE id = ?')));

  const replayConn = fakeConnection({ refreshRecord: { ...oldRecord, is_unexpired: 0, revoked_at: new Date() } });
  const replayService = new AuthService({ pool: { getConnection: async () => replayConn }, env });
  await assert.rejects(replayService.refresh('old-refresh-token-value-that-is-long-enough'),
    (error) => error.status === 401);
  assert.ok(replayConn.calls.some(([sql, values]) => sql.startsWith('UPDATE refresh_tokens SET revoked_at') && values[0] === oldRecord.session_id));
  assert.ok(replayConn.calls.some(([sql, values]) => sql.startsWith('UPDATE jwt_tokens SET is_revoked') && values[0] === oldRecord.session_id));
  assert.ok(replayConn.calls.some(([sql]) => sql === 'COMMIT'));
});

test('AuthService logout revokes all access and refresh tokens for a session', async () => {
  const connection = fakeConnection({ refreshRecord: { id: 3, session_id: 'b'.repeat(32), revoked_at: null } });
  const service = new AuthService({ pool: { getConnection: async () => connection }, env });
  await service.logout('refresh-token-value-long-enough-for-validation');
  assert.ok(connection.calls.some(([sql]) => sql.startsWith('UPDATE refresh_tokens SET revoked_at') && sql.includes('session_id')));
  assert.ok(connection.calls.some(([sql]) => sql.startsWith('UPDATE jwt_tokens SET is_revoked')));
});

function accessApp({ account, sessionId, token, databaseError = false }) {
  const pool = {
    query: async (sql) => {
      if (databaseError) throw new Error('database detail must stay hidden');
      if (sql.includes('FROM jwt_tokens')) return [[{
        id: 1, session_id: sessionId, user_id: String(account.id), user_type: account.userType,
        seller_id: account.userType === 'SELLER' ? String(account.id) : null,
        is_revoked: 0, is_unexpired: 1,
      }], []];
      if (sql.includes('FROM super_admins')) return [[{ ...account, is_active: 1 }], []];
      return [[], []];
    },
  };
  const authenticate = createAuthenticationMiddleware({ getPool: () => pool, env });
  const router = Router();
  router.get('/protected', authenticate, (req, res) => res.json({ user: req.auth.account }));
  return { app: createApp({ databasePoolProvider: () => pool, authRouter: router }), pool };
}

test('access middleware validates signed claims and checks active account/session state', async () => {
  const account = { id: 8, name: 'Admin', email: 'admin@example.com', userType: 'SUPER_ADMIN' };
  const sid = createSessionId();
  const access = issueAccessToken(account, sid, env);
  const server = await startServer(accessApp({ account, sessionId: sid, token: access.token }).app);
  try {
    const response = await fetch(`${server.baseUrl}/auth/protected`, { headers: { authorization: `Bearer ${access.token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.email, 'admin@example.com');
  } finally {
    await server.close();
  }

  const expired = issueAccessToken(account, sid, env, new Date(Date.now() - 3600000));
  const expiredServer = await startServer(accessApp({ account, sessionId: sid, token: expired.token }).app);
  try {
    const response = await fetch(`${expiredServer.baseUrl}/auth/protected`, { headers: { authorization: `Bearer ${expired.token}` } });
    assert.equal(response.status, 401);
  } finally {
    await expiredServer.close();
  }
});

test('GET /auth/me returns the server-created authenticated account context', async () => {
  const account = { id: '8', userType: 'ADMIN', email: 'admin@example.com', sellerId: null, verificationStatus: null };
  const router = createAuthRouter({
    getService: () => ({}),
    authenticate: (req, res, next) => { req.auth = { account }; next(); },
    limiter: allowThrough,
  });
  const server = await startServer(createApp({ authRouter: router }));
  try {
    const response = await fetch(`${server.baseUrl}/auth/me`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: account });
  } finally {
    await server.close();
  }
});

test('access middleware hides database errors and returns 401 for malformed tokens', async () => {
  const account = { id: 8, name: 'Admin', email: 'admin@example.com', userType: 'SUPER_ADMIN' };
  const sid = createSessionId();
  const access = issueAccessToken(account, sid, env);
  const broken = await startServer(accessApp({ account, sessionId: sid, token: access.token, databaseError: true }).app);
  try {
    const response = await fetch(`${broken.baseUrl}/auth/protected`, { headers: { authorization: `Bearer ${access.token}` } });
    assert.equal(response.status, 503);
    assert.equal(JSON.stringify(await response.json()).includes('database detail'), false);
  } finally {
    await broken.close();
  }

  const server = await startServer(accessApp({ account, sessionId: sid, token: access.token }).app);
  try {
    const response = await fetch(`${server.baseUrl}/auth/protected`, { headers: { authorization: 'Bearer invalid' } });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test('JWT verification enforces issuer, audience, and required expiry claims', () => {
  const sid = createSessionId();
  const wrongIssuer = jwt.sign(
    { sub: '8', userType: 'ADMIN', sellerId: null, sid },
    env.JWT_ACCESS_SECRET,
    { algorithm: 'HS256', issuer: 'other-service', audience: env.JWT_AUDIENCE, expiresIn: 900 },
  );
  assert.throws(() => verifyAccessToken(wrongIssuer, env));

  const missingExpiry = jwt.sign(
    { sub: '8', userType: 'ADMIN', sellerId: null, sid, jti: '86839dc5-0391-4e2c-b7ad-10408d979196' },
    env.JWT_ACCESS_SECRET,
    { algorithm: 'HS256', issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE },
  );
  assert.throws(() => verifyAccessToken(missingExpiry, env), /Invalid access token claims/);
});

test('permission checks deny users when no role permission is assigned', async () => {
  const pool = { query: async () => [[], []] };
  const router = Router();
  router.get('/manage', (req, res, next) => {
    req.auth = { userId: '7', userType: 'ADMIN', sellerId: null };
    next();
  }, requirePermission('accounts:manage'), (_req, res) => res.sendStatus(204));
  const server = await startServer(createApp({ databasePoolProvider: () => pool, authRouter: router }));
  try {
    const response = await fetch(`${server.baseUrl}/auth/manage`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'FORBIDDEN');
  } finally {
    await server.close();
  }
});

test('seller tenant and verification middleware reject cross-seller and unverified access', async () => {
  const router = Router();
  router.get('/seller/:sellerId', (req, res, next) => {
    req.auth = { userType: 'SELLER_USER', sellerId: '17', account: { verificationStatus: 'APPROVED' } };
    next();
  }, requireSellerTenant(), requireSellerVerified, (req, res) => res.json({ sellerId: req.sellerId }));
  router.get('/pending', (req, res, next) => {
    req.auth = { userType: 'SELLER', sellerId: '17', account: { verificationStatus: 'PENDING' } };
    next();
  }, requireSellerVerified, (_req, res) => res.sendStatus(204));
  const server = await startServer(createApp({ authRouter: router }));
  try {
    const denied = await fetch(`${server.baseUrl}/auth/seller/18`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'CROSS_SELLER_ACCESS_DENIED');

    const allowed = await fetch(`${server.baseUrl}/auth/seller/17`);
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { sellerId: '17' });

    const pending = await fetch(`${server.baseUrl}/auth/pending`);
    assert.equal(pending.status, 403);
    assert.equal((await pending.json()).error.code, 'SELLER_VERIFICATION_REQUIRED');
  } finally {
    await server.close();
  }
});

test('invalid JSON receives a safe client error', async () => {
  const server = await startServer(appFor());
  try {
    const response = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_JSON');
  } finally {
    await server.close();
  }
});
