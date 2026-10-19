import { passwordHasher } from './passwords.js';

async function inTransaction(pool, operation) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    connection.release();
  }
}

export class AccountService {
  constructor({ pool, hasher = passwordHasher }) {
    this.pool = pool;
    this.hasher = hasher;
  }

  async registerSeller(input) {
    const passwordHash = await this.hasher.hash(input.password);
    return inTransaction(this.pool, async (connection) => {
      const [sellerResult] = await connection.query(
        `INSERT INTO sellers
          (name, email, mobile_number, password_hash, business_name, gst_id,
           created_by, created_by_type, is_active, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, TRUE, 'PENDING')`,
        [input.name, input.email, input.mobileNumber ?? null, passwordHash, input.businessName, input.gstId ?? null],
      );
      const sellerId = String(sellerResult.insertId);
      await connection.query(
        "INSERT INTO seller_verifications (seller_id, verification_status) VALUES (?, 'PENDING')",
        [sellerId],
      );
      return {
        user: {
          id: sellerId,
          userType: 'SELLER',
          name: input.name,
          email: input.email,
          sellerId,
          verificationStatus: 'PENDING',
        },
      };
    });
  }

  async createSellerUser(sellerId, input) {
    const passwordHash = await this.hasher.hash(input.password);
    const [result] = await this.pool.query(
      `INSERT INTO seller_users
        (seller_id, email, mobile_number, password_hash, first_name, last_name, created_by, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [sellerId, input.email, input.mobileNumber ?? null, passwordHash, input.firstName, input.lastName, sellerId],
    );
    return {
      id: String(result.insertId),
      sellerId: String(sellerId),
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      isActive: true,
    };
  }

  async listSellerUsers(sellerId) {
    const [rows] = await this.pool.query(
      `SELECT id, email, mobile_number AS mobileNumber, first_name AS firstName,
              last_name AS lastName, is_active AS isActive, created_at AS createdAt
       FROM seller_users WHERE seller_id = ? ORDER BY id`,
      [sellerId],
    );
    return rows.map((row) => ({ ...row, id: String(row.id), isActive: Boolean(row.isActive) }));
  }

  async setSellerUserActive(sellerId, userId, isActive) {
    await this.pool.query(
      'UPDATE seller_users SET is_active = ? WHERE id = ? AND seller_id = ?',
      [isActive, userId, sellerId],
    );
    const [rows] = await this.pool.query(
      'SELECT id, is_active AS isActive FROM seller_users WHERE id = ? AND seller_id = ? LIMIT 1',
      [userId, sellerId],
    );
    if (!rows[0]) return null;
    return { id: String(rows[0].id), isActive: Boolean(rows[0].isActive) };
  }
}
