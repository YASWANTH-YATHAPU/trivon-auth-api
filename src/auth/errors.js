export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

export function invalidCredentialsError() {
  return new AuthError(401, 'INVALID_CREDENTIALS', 'Invalid email, password, or account context.');
}
