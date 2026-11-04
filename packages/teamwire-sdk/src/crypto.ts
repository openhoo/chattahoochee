import { secp256k1 } from '@noble/curves/secp256k1.js';
import { TeamwireProtocolError } from './errors';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[\da-f]{2})+$/i.test(value)) throw new TeamwireProtocolError('Invalid hexadecimal data.');
  return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)) {
    throw new TeamwireProtocolError('Invalid encrypted envelope encoding.');
  }
  try { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
  catch { throw new TeamwireProtocolError('Invalid encrypted envelope encoding.'); }
}

export function createEphemeralKey(): { secretKey: Uint8Array; publicKey: string } {
  const { secretKey } = secp256k1.keygen();
  return { secretKey, publicKey: toHex(secp256k1.getPublicKey(secretKey, false)) };
}

export function deriveSessionSecret(secretKey: Uint8Array, publicKey: string): string {
  try {
    const sharedPoint = secp256k1.getSharedSecret(secretKey, fromHex(publicKey), false);
    try { return toBase64(sharedPoint.slice(1, 25)); }
    finally { sharedPoint.fill(0); }
  } catch { throw new TeamwireProtocolError('Invalid server key exchange response.'); }
}

/** The protocol has an unkeyed IV digest, not an authenticated encryption tag. */
export class TeamwireCrypto {
  constructor(readonly implementation: Crypto) {
    if (!implementation?.subtle || !implementation.getRandomValues) {
      throw new TeamwireProtocolError('Web Crypto with AES-CBC and SHA-256 is required.');
    }
  }

  async importSecret(secret: string): Promise<CryptoKey> {
    const bytes = encoder.encode(secret);
    if (bytes.length !== 32) throw new TeamwireProtocolError('Invalid session or conversation key length.');
    try { return await this.implementation.subtle.importKey('raw', bytes, 'AES-CBC', false, ['encrypt', 'decrypt']); }
    finally { bytes.fill(0); }
  }

  async sha256(value: string): Promise<string> {
    return toHex(new Uint8Array(await this.implementation.subtle.digest('SHA-256', encoder.encode(value))));
  }

  requestId(): string {
    const bytes = this.implementation.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 15) | 64;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = toHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async encrypt(plaintext: string, key: CryptoKey): Promise<string> {
    const iv = this.implementation.getRandomValues(new Uint8Array(16));
    const digest = new Uint8Array(await this.implementation.subtle.digest('SHA-256', iv));
    const ciphertext = new Uint8Array(await this.implementation.subtle.encrypt({ name: 'AES-CBC', iv }, key, encoder.encode(plaintext)));
    const envelope = new Uint8Array(48 + ciphertext.length);
    envelope.set(iv);
    envelope.set(digest, 16);
    envelope.set(ciphertext, 48);
    return toBase64(envelope);
  }

  async decrypt(envelope: string, key: CryptoKey): Promise<string> {
    const bytes = fromBase64(envelope);
    if (bytes.length < 64 || (bytes.length - 48) % 16 !== 0) {
      throw new TeamwireProtocolError('Invalid encrypted envelope length.');
    }
    const iv = bytes.slice(0, 16);
    const digest = new Uint8Array(await this.implementation.subtle.digest('SHA-256', iv));
    let difference = 0;
    for (let index = 0; index < 32; index++) difference |= digest[index]! ^ bytes[index + 16]!;
    if (difference !== 0) throw new TeamwireProtocolError('Invalid encrypted envelope IV digest.');
    try {
      const plaintext = await this.implementation.subtle.decrypt({ name: 'AES-CBC', iv }, key, bytes.slice(48));
      return decoder.decode(plaintext);
    } catch { throw new TeamwireProtocolError('The encrypted response could not be decrypted.'); }
  }
}
