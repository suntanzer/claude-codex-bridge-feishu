import { createDecipheriv, createHash } from 'node:crypto';

export function decryptFeishuPayload(encryptKey, encrypted) {
  const key = createHash('sha256').update(String(encryptKey || ''), 'utf8').digest();
  const source = Buffer.from(String(encrypted || ''), 'base64');
  if (source.length <= 16) {
    throw new Error('Encrypted Feishu payload is too short.');
  }
  const iv = source.subarray(0, 16);
  const ciphertext = source.subarray(16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

export function unwrapFeishuPayload(payload, encryptKey = '') {
  if (!payload?.encrypt) {
    return payload;
  }
  if (!encryptKey) {
    throw new Error('Received encrypted Feishu payload but FEISHU_ENCRYPT_KEY is not configured.');
  }
  return JSON.parse(decryptFeishuPayload(encryptKey, payload.encrypt));
}

export function extractFeishuVerificationToken(payload) {
  return String(payload?.token || payload?.header?.token || '').trim();
}

export function isFeishuUrlVerification(payload) {
  return String(payload?.type || '').trim() === 'url_verification';
}
