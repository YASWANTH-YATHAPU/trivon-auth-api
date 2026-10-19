export const ACCOUNT_TYPES = Object.freeze([
  'SUPER_ADMIN',
  'ADMIN',
  'ACCOUNTANT',
  'SELLER',
  'CUSTOMER_CARE',
  'SELLER_USER',
]);

export const ACCOUNT_TABLES = Object.freeze({
  SUPER_ADMIN: 'super_admins',
  ADMIN: 'admins',
  ACCOUNTANT: 'accountants',
  SELLER: 'sellers',
  CUSTOMER_CARE: 'customer_care',
  SELLER_USER: 'seller_users',
});

export function resolveAccountTable(userType) {
  return ACCOUNT_TABLES[userType] ?? null;
}

export function validateLoginContext({ userType, sellerId }) {
  if (!resolveAccountTable(userType)) return 'Unsupported account type.';
  if (userType === 'SELLER_USER' && !sellerId) return 'sellerId is required for SELLER_USER login.';
  if (userType !== 'SELLER_USER' && sellerId !== undefined) return 'sellerId is only accepted for SELLER_USER login.';
  return null;
}
