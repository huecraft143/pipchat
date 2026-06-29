'use strict';

class CryptoManager {
  #na = null;

  #enc(b) { return this.#na.to_base64(b, this.#na.base64_variants.URLSAFE_NO_PADDING); }
  #dec(s) { return this.#na.from_base64(s, this.#na.base64_variants.URLSAFE_NO_PADDING); }

  async init() {
    // Wait up to 10 s for window.sodium (set by libsodium-wrappers after libsodium loads)
    const deadline = Date.now() + 10000;
    while (!window.sodium && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
    }
    const s = window.sodium;
    if (!s) throw new Error('libsodium not loaded — check network connection');
    await s.ready;
    this.#na = s;
  }

  generateKeypair() {
    const kp = this.#na.crypto_sign_keypair();
    return {
      signPub: this.#enc(kp.publicKey),
      signSec: this.#enc(kp.privateKey),
      boxPub:  this.#enc(this.#na.crypto_sign_ed25519_pk_to_curve25519(kp.publicKey)),
      boxSec:  this.#enc(this.#na.crypto_sign_ed25519_sk_to_curve25519(kp.privateKey)),
    };
  }

  // Genera una coppia Curve25519 pura per chiavi effimere di sessione
  generateBoxKeypair() {
    const kp = this.#na.crypto_box_keypair();
    return { boxPub: this.#enc(kp.publicKey), boxSec: this.#enc(kp.privateKey) };
  }

  // Raw X25519 scalar multiplication (both keypair parties compute the same output)
  dh(mySecB64, theirPubB64) {
    return this.#enc(this.#na.crypto_scalarmult(this.#dec(mySecB64), this.#dec(theirPubB64)));
  }

  // Combine three DH outputs into one shared secret via BLAKE2b
  x3dhSecret(dh1B64, dh2B64, dh3B64) {
    const d1 = this.#dec(dh1B64), d2 = this.#dec(dh2B64), d3 = this.#dec(dh3B64);
    const cat = new Uint8Array(d1.length + d2.length + d3.length);
    cat.set(d1, 0); cat.set(d2, d1.length); cat.set(d3, d1.length + d2.length);
    return this.#enc(this.#na.crypto_generichash(32, cat));
  }

  // Derive two independent 32-byte chain keys from a shared secret
  sessionChainKeys(secretB64) {
    const key = this.#dec(secretB64);
    return {
      ck1: this.#enc(this.#na.crypto_generichash(32, this.#na.from_string('pipchat-chain-1'), key)),
      ck2: this.#enc(this.#na.crypto_generichash(32, this.#na.from_string('pipchat-chain-2'), key)),
    };
  }

  // KDF chain step: returns next chain key + one-time message key
  chainStep(chainKeyB64) {
    const key = this.#dec(chainKeyB64);
    return {
      newChainKey: this.#enc(this.#na.crypto_generichash(32, this.#na.from_string('advance'), key)),
      msgKey:      this.#enc(this.#na.crypto_generichash(32, this.#na.from_string('msgkey'),  key)),
    };
  }

  // Symmetric encrypt/decrypt with a 32-byte message key (secretbox)
  encryptMsg(plaintext, msgKeyB64) {
    const key   = this.#dec(msgKeyB64);
    const nonce = this.#na.randombytes_buf(this.#na.crypto_secretbox_NONCEBYTES);
    const ct    = this.#na.crypto_secretbox_easy(this.#na.from_string(plaintext), nonce, key);
    return { ct: this.#enc(ct), nonce: this.#enc(nonce) };
  }

  decryptMsg(ctB64, nonceB64, msgKeyB64) {
    try {
      const key = this.#dec(msgKeyB64);
      return this.#na.to_string(
        this.#na.crypto_secretbox_open_easy(this.#dec(ctB64), this.#dec(nonceB64), key)
      );
    } catch(_) { return null; }
  }

  // userId = first 8 chars of BLAKE2b hash of pubkey, base64url
  userId(signPubB64) {
    const h = this.#na.crypto_generichash(6, this.#dec(signPubB64));
    return this.#enc(h).replace(/[^a-zA-Z0-9]/g,'').slice(0,8).toLowerCase();
  }

  toCurvePub(signPubB64) {
    return this.#enc(this.#na.crypto_sign_ed25519_pk_to_curve25519(this.#dec(signPubB64)));
  }

  // Asymmetric encrypt: box(msg, nonce, recipientXPub, senderXSec)
  encrypt(plaintext, recipientBoxPubB64, senderBoxSecB64) {
    const nonce = this.#na.randombytes_buf(this.#na.crypto_box_NONCEBYTES);
    const ct = this.#na.crypto_box_easy(
      this.#na.from_string(plaintext),
      nonce,
      this.#dec(recipientBoxPubB64),
      this.#dec(senderBoxSecB64)
    );
    return { ct: this.#enc(ct), nonce: this.#enc(nonce) };
  }

  decrypt(ctB64, nonceB64, senderBoxPubB64, myBoxSecB64) {
    try {
      const pt = this.#na.crypto_box_open_easy(
        this.#dec(ctB64),
        this.#dec(nonceB64),
        this.#dec(senderBoxPubB64),
        this.#dec(myBoxSecB64)
      );
      return this.#na.to_string(pt);
    } catch(_) { return null; }
  }

  sign(data, signSecB64) {
    return this.#enc(this.#na.crypto_sign_detached(this.#na.from_string(data), this.#dec(signSecB64)));
  }

  verify(data, sigB64, signPubB64) {
    try {
      return this.#na.crypto_sign_verify_detached(this.#dec(sigB64), this.#na.from_string(data), this.#dec(signPubB64));
    } catch(_) { return false; }
  }

  genGroupKey() {
    return this.#enc(this.#na.randombytes_buf(this.#na.crypto_secretbox_KEYBYTES));
  }

  encryptSym(plaintext, keyB64) {
    const nonce = this.#na.randombytes_buf(this.#na.crypto_secretbox_NONCEBYTES);
    const ct = this.#na.crypto_secretbox_easy(this.#na.from_string(plaintext), nonce, this.#dec(keyB64));
    return { ct: this.#enc(ct), nonce: this.#enc(nonce) };
  }

  decryptSym(ctB64, nonceB64, keyB64) {
    try {
      return this.#na.to_string(
        this.#na.crypto_secretbox_open_easy(this.#dec(ctB64), this.#dec(nonceB64), this.#dec(keyB64))
      );
    } catch(_) { return null; }
  }
}

const Crypto = new CryptoManager();
