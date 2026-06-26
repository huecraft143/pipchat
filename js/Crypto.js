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

  b64enc(b) { return this.#enc(b); }
  b64dec(s) { return this.#dec(s); }

  generateKeypair() {
    const kp = this.#na.crypto_sign_keypair();
    return {
      signPub: this.#enc(kp.publicKey),
      signSec: this.#enc(kp.privateKey),
      boxPub:  this.#enc(this.#na.crypto_sign_ed25519_pk_to_curve25519(kp.publicKey)),
      boxSec:  this.#enc(this.#na.crypto_sign_ed25519_sk_to_curve25519(kp.privateKey)),
    };
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
