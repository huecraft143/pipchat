'use strict';

class IdentityManager {
  #kp  = null;
  #uid = null;

  async init() {
    const stored = await Storage.loadIdentity();
    if (stored && stored.signPub) {
      this.#kp  = stored;
      this.#uid = Crypto.userId(this.#kp.signPub);
      return false; // existing identity
    }
    this.#kp  = Crypto.generateKeypair();
    this.#uid = Crypto.userId(this.#kp.signPub);
    await Storage.saveIdentity(this.#kp);
    return true; // new identity
  }

  kp()      { return this.#kp; }
  uid()     { return this.#uid; }
  signPub() { return this.#kp?.signPub; }
  boxPub()  { return this.#kp?.boxPub; }

  async export() {
    if (!this.#kp) return null;
    return btoa(JSON.stringify(this.#kp));
  }

  async import(b64) {
    try {
      const data = JSON.parse(atob(b64));
      if (!data.signPub || !data.signSec) return false;
      this.#kp  = data;
      this.#uid = Crypto.userId(this.#kp.signPub);
      await Storage.saveIdentity(this.#kp);
      return true;
    } catch(_) { return false; }
  }

  async destroy() {
    this.#kp  = null;
    this.#uid = null;
    await Storage.nuke();
  }
}

const Identity = new IdentityManager();
