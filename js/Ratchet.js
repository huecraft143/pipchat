'use strict';

const MAX_SKIP = 100; // max out-of-order message keys to cache per conversation

class RatchetManager {

  async hasSession(uid) {
    return !!(await Storage.getRatchetState(uid));
  }

  // Initialize a symmetric ratchet session from an X3DH shared secret.
  // isInitiator = true for Alice (sender of first message), false for Bob.
  // sessionId   = Alice's ephemeral pub (ekPub), unique per X3DH handshake.
  async initSession(uid, sharedSecret, isInitiator, sessionId) {
    const { ck1, ck2 } = Crypto.sessionChainKeys(sharedSecret);
    const state = {
      uid,
      sendChainKey: isInitiator ? ck1 : ck2,
      recvChainKey: isInitiator ? ck2 : ck1,
      sendCount:    0,
      recvCount:    0,
      skippedKeys:  {},
      sessionId,
    };
    await Storage.saveRatchetState(state);
    console.log('[RATCHET][INIT]', uid.slice(0, 8), isInitiator ? 'initiator' : 'responder', 'session:', sessionId.slice(0, 8));
    return state;
  }

  // Encrypt plaintext, advance send chain. Returns { ct, nonce, msgNum }.
  async encrypt(uid, innerObj) {
    const state = await Storage.getRatchetState(uid);
    if (!state) throw new Error('[RATCHET] no session for ' + uid);

    const { newChainKey, msgKey } = Crypto.chainStep(state.sendChainKey);
    const msgNum = state.sendCount;

    const { ct, nonce } = Crypto.encryptMsg(JSON.stringify(innerObj), msgKey);

    state.sendChainKey = newChainKey;
    state.sendCount++;
    await Storage.saveRatchetState(state);

    console.log('[RATCHET][ENC]', uid.slice(0, 8), 'msgNum:', msgNum);
    return { ct, nonce, msgNum };
  }

  // Decrypt a message at msgNum. Handles out-of-order via skippedKeys cache.
  // Returns parsed inner object, or null on failure.
  async decrypt(uid, ct, nonce, msgNum) {
    const state = await Storage.getRatchetState(uid);
    if (!state) throw new Error('[RATCHET] no session for ' + uid);

    // Check skipped-keys cache first (out-of-order delivery)
    const skipKey = String(msgNum);
    if (state.skippedKeys[skipKey]) {
      const msgKey = state.skippedKeys[skipKey];
      delete state.skippedKeys[skipKey];
      await Storage.saveRatchetState(state);
      const pt = Crypto.decryptMsg(ct, nonce, msgKey);
      console.log('[RATCHET][DEC]', uid.slice(0, 8), 'msgNum:', msgNum, '(cached)', pt ? 'ok' : 'FAIL');
      return pt ? JSON.parse(pt) : null;
    }

    if (msgNum < state.recvCount) {
      console.warn('[RATCHET][DEC]', uid.slice(0, 8), 'msgNum:', msgNum, '< recvCount:', state.recvCount, '— replay, ignored');
      return null;
    }
    if (msgNum - state.recvCount > MAX_SKIP) {
      console.warn('[RATCHET][DEC]', uid.slice(0, 8), 'too many skipped:', msgNum - state.recvCount);
      return null;
    }

    // Advance chain, caching keys for any skipped messages
    let ck = state.recvChainKey;
    for (let i = state.recvCount; i < msgNum; i++) {
      const step = Crypto.chainStep(ck);
      state.skippedKeys[String(i)] = step.msgKey;
      ck = step.newChainKey;
    }
    const { newChainKey, msgKey } = Crypto.chainStep(ck);
    state.recvChainKey = newChainKey;
    state.recvCount    = msgNum + 1;
    await Storage.saveRatchetState(state);

    const pt = Crypto.decryptMsg(ct, nonce, msgKey);
    console.log('[RATCHET][DEC]', uid.slice(0, 8), 'msgNum:', msgNum, pt ? 'ok' : 'FAIL');
    return pt ? JSON.parse(pt) : null;
  }

  async deleteSession(uid) {
    await Storage.delRatchetState(uid);
    console.log('[RATCHET][DEL]', uid.slice(0, 8));
  }
}

const Ratchet = new RatchetManager();
