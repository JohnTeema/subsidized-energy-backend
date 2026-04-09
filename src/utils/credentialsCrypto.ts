import crypto from 'crypto';

const ALGO = 'aes-256-cbc';

function getKey(): Buffer {
  const secret = process.env.CREDENTIALS_SECRET;
  if (secret && secret.length === 64) {
    return Buffer.from(secret, 'hex');
  }
  // Fallback dev key — not secure for production
  return Buffer.from('0'.repeat(64), 'hex');
}

export function encryptCredentials(credentials: Record<string, string>): string {
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credentials), 'utf8'),
    cipher.final(),
  ]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decryptCredentials(encryptedStr: string): Record<string, string> {
  const [ivHex, encryptedHex] = encryptedStr.split(':');
  if (!ivHex || !encryptedHex) {
    // Legacy: plain JSON stored before encryption was added
    try {
      return JSON.parse(encryptedStr) as Record<string, string>;
    } catch {
      return {};
    }
  }
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedData = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as Record<string, string>;
}
