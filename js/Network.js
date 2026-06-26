'use strict';

class NetworkManager {
  #gun  = null;
  #online = false;
  #peers  = 0;
  #dmCb   = null;
  #listening = false;
  #seen  = new Set();
  #grpListeners = {};

  #RELAYS = [
    'https://pipchat.onrender.com/gun',
  ];

  async init() {
    this.#gun = Gun({ peers: [this.#RELAYS[0]], localStorage: false, radisk: false });

    this.#gun.on('hi', () => {
      this.#peers++;
      this.#online = true;
      UI.connStatus(true, this.#peers);
      this.flushPending();
    });
    this.#gun.on('bye', () => {
      this.#peers = Math.max(0, this.#peers - 1);
      if (!this.#peers) { this.#online = false; UI.connStatus(false, 0); }
    });

    // Try extra relays after short delay
    setTimeout(() => {
      try { this.#RELAYS.slice(1).forEach(r => this.#gun.opt({peers:[r]})); } catch(_) {}
    }, 3000);
  }

  get online()    { return this.#online; }
  get peerCount() { return this.#peers; }

  startListening() {
    if (this.#listening || !this.#gun) return;
    this.#listening = true;
    const myUid = Identity.uid();
    this.#gun.get('pipchat_inbox_' + myUid).map().on((data, key) => {
      if (!data || !data.ct || this.#seen.has(key)) return;
      this.#seen.add(key);
      if (this.#dmCb) this.#dmCb(data, key);
    });
  }

  setDmCallback(cb) { this.#dmCb = cb; }

  async publishProfile(profile) {
    if (!this.#gun) return;
    this.#gun.get('pipchat_profiles').get(profile.uid).put(profile);
  }

  async lookupProfile(uid) {
    return new Promise(res => {
      if (!this.#gun) return res(null);
      const t = setTimeout(() => res(null), 5000);
      this.#gun.get('pipchat_profiles').get(uid).once(d => { clearTimeout(t); res(d||null); });
    });
  }

  async sendDM(recipientUid, blob) {
    if (!this.#gun || !this.#online) {
      await Storage.addPending({recipientUid, blob, ts: Date.now()});
      return false;
    }
    try {
      this.#gun.get('pipchat_inbox_' + recipientUid).set(blob);
      return true;
    } catch(_) {
      await Storage.addPending({recipientUid, blob, ts: Date.now()});
      return false;
    }
  }

  async flushPending() {
    if (!this.#online || !this.#gun) return;
    const items = await Storage.getPending();
    if (!items.length) return;
    let sentCount = 0;
    await Promise.all(items.map(item => new Promise(res => {
      const timer = setTimeout(res, 8000); // treat timeout as failure
      this.#gun.get('pipchat_inbox_' + item.recipientUid).set(item.blob, async ack => {
        clearTimeout(timer);
        if (!ack.err) { await Storage.delPending(item.id); sentCount++; }
        res();
      });
    })));
    if (sentCount) UI.notify(PIP.sent, 'info');
  }

  listenGroup(groupId, cb) {
    if (!this.#gun || this.#grpListeners[groupId]) return;
    this.#grpListeners[groupId] = true;
    this.#gun.get('pipchat_grp_' + groupId).get('msg').map().on((data, key) => {
      const k = 'g_' + key;
      if (!data || !data.ct || this.#seen.has(k)) return;
      this.#seen.add(k);
      cb(data, key);
    });
  }

  async sendGroup(groupId, blob) {
    if (!this.#gun) return false;
    this.#gun.get('pipchat_grp_' + groupId).get('msg').set(blob);
    return true;
  }

  async publishGroupInfo(groupId, info) {
    if (!this.#gun) return;
    this.#gun.get('pipchat_grp_' + groupId).get('info').put(info);
  }

  async lookupGroupInfo(groupId) {
    return new Promise(res => {
      if (!this.#gun) return res(null);
      const t = setTimeout(() => res(null), 4000);
      this.#gun.get('pipchat_grp_' + groupId).get('info').once(d => { clearTimeout(t); res(d||null); });
    });
  }
}

const Network = new NetworkManager();
