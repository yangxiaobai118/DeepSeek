import crypto from 'node:crypto';

/** Deep-remove keys whose value is undefined (keeps JSON output clean). */
export function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

export function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(s) {
  return Buffer.from(s, 'base64url');
}

export function genUuid() {
  return crypto.randomUUID();
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Derive the X25519 public key (websafe base64, no padding) that Reality
 * clients need from a 32-byte raw private key in the same encoding.
 */
export function x25519PublicFromPrivate(privB64) {
  const raw = fromB64url(privB64);
  if (raw.length !== 32) throw new Error('reality privateKey must be 32 bytes (base64url)');
  const pkcs8Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
  const der = Buffer.concat([pkcs8Prefix, raw]);
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv);
  const spki = pub.export({ format: 'der', type: 'spki' });
  // X25519 SPKI DER ends with the 32-byte u-coordinate.
  return b64url(spki.subarray(spki.length - 32));
}

/** Generate a fresh Reality keypair in Xray/sing-box wire format. */
export function genRealityKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  const pubDer = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey: b64url(privDer.subarray(privDer.length - 32)),
    publicKey: b64url(pubDer.subarray(pubDer.length - 32)),
  };
}

export function genShortId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Placeholder IPs from documentation ranges, or every unset value. */
export function isPlaceholderAddress(value) {
  if (!value) return true;
  const v = String(value).trim();
  if (v === 'YOUR_SERVER_IP' || v === 'REPLACE_ME' || v === '203.0.113.10') return true;
  return /^203\.0\.113\./.test(v) || /^198\.51\.100\./.test(v) || /^192\.0\.2\./.test(v);
}

/** Format bytes so the dashboard and doctor agree on units. */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}
