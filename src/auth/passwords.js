import bcrypt from 'bcryptjs';

const workFactor = Number(process.env.BCRYPT_WORK_FACTOR ?? 12);

if (!Number.isInteger(workFactor) || workFactor < 10 || workFactor > 15) {
  throw new Error('BCRYPT_WORK_FACTOR must be an integer from 10 to 15.');
}

export const passwordHasher = Object.freeze({
  hash(password) {
    return bcrypt.hash(password, workFactor);
  },
  compare(password, passwordHash) {
    return bcrypt.compare(password, passwordHash);
  },
});
