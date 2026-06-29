'use strict';

class NetworkManager {
  #gun              = null;
  #online           = false;
  #peers            = 0;
  #profile          = null;

  #dmCb              = null;
  #dmModeCallback    = null;
  #dmRequestCallback = null;

  #grpCbs            = {};
  #seen              = new Set();

  #rtcConns          = {};
  #channels          = {};
  #peerGroups        = {};
  #grpListening      = new Set();
  #pendingCandidates = {};
  #grpPending        = {};
  #grpPendingIdbIds  = {};
  #dmMode            = {};  // uid → 'relay'|'requesting'|'connecting'|'direct'
  #ephemKp           = null;
  #ephemCache        = {};   // uid → { pub, at } — cache fetchEphemPub

  #RELAYS = ['https://pipchat.onrender.com/gun'];

  #RTC = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302'  },
      { urls: 'stun:stun1.l.google.com:19302' },
    ]
  };

  // ── INIT ─────────────────────────────────────────────────────

  async init() {
    this.#gun = Gun({ peers: [this.#RELAYS[0]], localStorage: false, radisk: false });
    this.#gun.on('hi', () => {
      this.#peers++;
      this.#online = true;
      UI.connStatus(true, this.#peers);
      if (this.#profile) this.#gun.get('pipchat_profiles').get(this.#profile.uid).put(this.#profile);
      this.#reannouncePresence();
    });
    this.#gun.on('bye', () => {
      this.#peers = Math.max(0, this.#peers - 1);
      if (!this.#peers) { this.#online = false; UI.connStatus(false, 0); }
    });
  }

  get online()    { return this.#online; }
  get peerCount() { return this.#peers; }

  // ── SIGNALING ─────────────────────────────────────────────────

  startListening() {
    const myUid = Identity.uid();

    // ephemeral session keypair — in-memory only, rotates on every reload
    this.#ephemKp = Crypto.generateBoxKeypair();
    this.#gun.get('pipchat_ephem_' + myUid).put({ boxPub: this.#ephemKp.boxPub, ts: Date.now() });

    // Pre-populate #seen with signal keys processed in previous page loads (TTL 2min).
    // Prevents Gun from replaying stale dm_rtc_request/accept signals after a tab reload/reopen.
    this.#loadPersistedSeen();

    this.#gun.get('pipchat_signal_' + myUid).map().on((sig, key) => {
      if (!sig || !sig.type || !sig.from) return;
      if (this.#seen.has('s_' + key)) return;
      this.#seen.add('s_' + key);
      if (sig.ts && Date.now() - sig.ts > 60000) return;
      this.#persistSeen('s_' + key);
      this.#handleSignal(sig).catch(() => {});
    });

    this.#gun.get('pipchat_dm_' + myUid).map().on((blob, key) => {
      if (!blob || !blob.ct) return;
      if (this.#seen.has('r_' + key)) return;
      if (blob.id && this.#seen.has(blob.id)) return;
      // discard expired blobs and remove from relay
      if (blob.expires && Date.now() > blob.expires) {
        this.#gun.get('pipchat_dm_' + myUid).get(key).put(null);
        return;
      }
      this.#seen.add('r_' + key);
      if (blob.id) this.#seen.add(blob.id);
      console.log('[DM][RELAY] received from', blob.from?.slice(0, 8), 'id:', blob.id?.slice(0, 12));
      if (this.#dmCb) this.#dmCb(blob, key);
      // delete from relay after delivery (best-effort)
      setTimeout(() => this.#gun.get('pipchat_dm_' + myUid).get(key).put(null), 2000);
    });
  }

  async #handleSignal(sig) {
    const { from, type } = sig;

    if (type === 'request') {
      if (!this.#rtcConns[from]) this.#offer(from).catch(() => {});

    } else if (type === 'offer') {
      await this.#accept(from, sig.sdp);

    } else if (type === 'answer') {
      const pc = this.#rtcConns[from];
      if (pc) {
        await pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
        await this.#flushCandidates(from, pc);
      }

    } else if (type === 'candidate') {
      const pc  = this.#rtcConns[from];
      const c   = sig.candidateJSON ? JSON.parse(sig.candidateJSON) : sig.candidate;
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) { console.warn('[WebRTC] addIceCandidate:', e); }
      } else {
        if (!this.#pendingCandidates[from]) this.#pendingCandidates[from] = [];
        this.#pendingCandidates[from].push(c);
      }

    } else if (type === 'dm_rtc_request') {
      if (this.#dmRequestCallback) this.#dmRequestCallback(from);

    } else if (type === 'dm_rtc_accept') {
      // guard against stale Gun-replayed accepts — only process if we have an active outgoing request
      if ((this.#dmMode[from] || 'relay') !== 'requesting') return;
      const dc = this.#channels[from];
      if (dc?.readyState === 'open') {
        this.#setDmMode(from, 'direct');
      } else {
        this.#setDmMode(from, 'connecting');
        this.#offer(from).catch(() => this.#setDmMode(from, 'relay'));
      }

    } else if (type === 'dm_rtc_reject') {
      this.#dmMode[from] = 'relay';
      if (this.#dmModeCallback) this.#dmModeCallback(from, 'rejected');

    } else if (type === 'dm_rtc_close') {
      this.#cleanPeer(from);
    }
  }

  #sig(toUid, payload) {
    if (!this.#gun) return;
    this.#gun.get('pipchat_signal_' + toUid).set({ ...payload, from: Identity.uid(), ts: Date.now() });
  }

  // ── DM DIRECT MODE ────────────────────────────────────────────

  getDmMode(uid) { return this.#dmMode[uid] || 'relay'; }

  #setDmMode(uid, mode) {
    console.log('[DM][MODE]', uid.slice(0, 8), '→', mode);
    this.#dmMode[uid] = mode;
    if (this.#dmModeCallback) this.#dmModeCallback(uid, mode);
  }

  setDmModeCallback(cb)    { this.#dmModeCallback    = cb; }
  setDmRequestCallback(cb) { this.#dmRequestCallback = cb; }

  get ephemKp() { return this.#ephemKp; }

  async fetchEphemPub(uid) {
    const cached = this.#ephemCache[uid];
    if (cached && Date.now() - cached.at < 30000) return cached.pub;
    return new Promise(res => {
      const t = setTimeout(() => res(null), 3000);
      this.#gun.get('pipchat_ephem_' + uid).once(data => {
        clearTimeout(t);
        const pub = data?.boxPub || null;
        if (pub) this.#ephemCache[uid] = { pub, at: Date.now() };
        res(pub);
      });
    });
  }

  requestDirect(uid) {
    const cur = this.#dmMode[uid] || 'relay';
    if (cur === 'direct' || cur === 'requesting' || cur === 'connecting') return;
    this.#setDmMode(uid, 'requesting');
    this.#sig(uid, { type: 'dm_rtc_request' });
    setTimeout(() => {
      if ((this.#dmMode[uid] || 'relay') === 'requesting') this.#setDmMode(uid, 'relay');
    }, 30000);
  }

  acceptDirect(uid) {
    const dc = this.#channels[uid];
    if (dc?.readyState === 'open') {
      this.#setDmMode(uid, 'direct');
    } else {
      this.#setDmMode(uid, 'connecting');
    }
    this.#sig(uid, { type: 'dm_rtc_accept' });
  }

  rejectDirect(uid) {
    this.#sig(uid, { type: 'dm_rtc_reject' });
  }

  closeDirect(uid) {
    this.#cleanPeer(uid);
    this.#sig(uid, { type: 'dm_rtc_close' });
  }

  closeAllDirect() {
    for (const [uid, mode] of Object.entries(this.#dmMode)) {
      if (mode === 'direct' || mode === 'connecting') {
        this.#sig(uid, { type: 'dm_rtc_close' });
        this.#cleanPeer(uid);
      }
    }
  }

  // ── WebRTC ────────────────────────────────────────────────────

  #makePc(uid) {
    const savedMode = this.#dmMode[uid];
    this.#cleanPeer(uid);
    if (savedMode) this.#dmMode[uid] = savedMode;

    const pc = new RTCPeerConnection(this.#RTC);
    this.#rtcConns[uid] = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      // Filter host candidates with real IPs — mDNS (.local) are UUID-based and don't expose your IP
      if (candidate.type === 'host' && !candidate.address?.endsWith('.local')) {
        console.log('[ICE][FILTERED] host IP:', candidate.address);
        return;
      }
      this.#sig(uid, { type: 'candidate', candidateJSON: JSON.stringify(candidate.toJSON()) });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') {
        if (this.#rtcConns[uid] === pc) this.#cleanPeer(uid);
      } else if (s === 'disconnected') {
        setTimeout(() => {
          if (this.#rtcConns[uid] === pc &&
              (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) {
            this.#cleanPeer(uid);
          }
        }, 6000);
      }
    };
    return pc;
  }

  #cleanPeer(uid) {
    const pc = this.#rtcConns[uid];
    if (pc) { try { pc.close(); } catch(_) {} }
    delete this.#rtcConns[uid];
    const dc = this.#channels[uid];
    if (dc) { try { dc.close(); } catch(_) {} }
    delete this.#channels[uid];
    delete this.#pendingCandidates[uid];
    const mode = this.#dmMode[uid];
    if (mode === 'direct' || mode === 'connecting') {
      this.#dmMode[uid] = 'relay';
      if (this.#dmModeCallback) this.#dmModeCallback(uid, 'relay');
    }
  }

  async #flushCandidates(uid, pc) {
    const list = this.#pendingCandidates[uid];
    if (!list?.length) return;
    delete this.#pendingCandidates[uid];
    for (const c of list) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(_) {}
    }
  }

  async #offer(uid) {
    const pc = this.#makePc(uid);
    const dc = pc.createDataChannel('msg', { ordered: true });
    this.#wire(uid, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.#sig(uid, { type: 'offer', sdp: offer.sdp });
  }

  async #accept(uid, sdp) {
    if (this.#channels[uid]?.readyState === 'open') return;
    const existing = this.#rtcConns[uid];
    if (existing) {
      const s = existing.connectionState;
      if (s !== 'failed' && s !== 'closed') return;
    }
    const pc = this.#makePc(uid);
    pc.ondatachannel = ({ channel }) => this.#wire(uid, channel);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await this.#flushCandidates(uid, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.#sig(uid, { type: 'answer', sdp: answer.sdp });
  }

  #wire(uid, dc) {
    this.#channels[uid] = dc;
    dc.onopen    = () => {
      console.log('[WebRTC] channel open:', uid.slice(0, 8));
      if (this.#dmMode[uid] === 'connecting') this.#setDmMode(uid, 'direct');
      this.#flushGrpPending(uid, dc);
    };
    dc.onmessage = ({ data }) => { try { this.#route(JSON.parse(data)); } catch(_) {} };
    dc.onclose   = () => {
      if (this.#channels[uid] === dc) {
        delete this.#channels[uid];
        const mode = this.#dmMode[uid];
        if (mode === 'direct' || mode === 'connecting') {
          this.#dmMode[uid] = 'relay';
          if (this.#dmModeCallback) this.#dmModeCallback(uid, 'relay');
        }
      }
    };
  }

  #flushGrpPending(uid, dc) {
    const sharedGroups = this.#peerGroups[uid];
    if (!sharedGroups) return;
    for (const groupId of sharedGroups) {
      const pending = this.#grpPending[groupId];
      if (!pending?.length) continue;
      for (const blob of pending) {
        dc.send(JSON.stringify({ type: 'grp', groupId, blob }));
        const idbId = this.#grpPendingIdbIds[blob.id];
        if (idbId !== undefined) {
          Storage.delPending(idbId).catch(() => {});
          delete this.#grpPendingIdbIds[blob.id];
        }
      }
    }
  }

  #route(msg) {
    const id = msg.blob?.id;
    if (!id || this.#seen.has(id)) return;
    this.#seen.add(id);
    if (msg.type === 'dm' && this.#dmCb) {
      console.log('[DM][DIRECT] received from', msg.blob?.from?.slice(0, 8), 'id:', id?.slice(0, 12));
      this.#dmCb(msg.blob, id);
    } else if (msg.type === 'grp' && msg.groupId && this.#grpCbs[msg.groupId]) {
      this.#grpCbs[msg.groupId](msg.blob, id);
    }
  }

  // ── SEND ─────────────────────────────────────────────────────

  async sendDM(recipientUid, blob) {
    const mode = this.#dmMode[recipientUid] || 'relay';
    if (mode === 'direct') {
      const dc = this.#channels[recipientUid];
      if (dc?.readyState === 'open') {
        try {
          dc.send(JSON.stringify({ type: 'dm', blob }));
          console.log('[DM][DIRECT] sent to', recipientUid.slice(0, 8), 'id:', blob.id?.slice(0, 12));
          return 'direct';
        } catch(_) {
          console.warn('[DM][DIRECT] send failed (channel race), falling to relay');
        }
      } else {
        console.warn('[DM][DIRECT] channel not open (readyState:', dc?.readyState, '), reverting to relay');
      }
      this.#setDmMode(recipientUid, 'relay');
      return 'failed';
    }
    console.log('[DM][RELAY] sending to', recipientUid.slice(0, 8), 'id:', blob.id?.slice(0, 12), this.#online ? '' : '(offline — queued)');
    this.#gun.get('pipchat_dm_' + recipientUid).set(blob);
    return this.#online ? 'relay' : 'queued';
  }

  sendGroup(groupId, blob) {
    const msg = JSON.stringify({ type: 'grp', groupId, blob });
    let sent = false;
    for (const [uid, dc] of Object.entries(this.#channels)) {
      if (dc.readyState === 'open' && this.#peerGroups[uid]?.has(groupId)) {
        try { dc.send(msg); sent = true; } catch(e) { console.error('[GRP] send failed:', e); }
      }
    }
    if (!sent) {
      if (!this.#grpPending[groupId]) this.#grpPending[groupId] = [];
      this.#grpPending[groupId].push(blob);
      Storage.addPending({ type: 'grp', groupId, blob, ts: Date.now() })
        .then(id => { this.#grpPendingIdbIds[blob.id] = id; })
        .catch(() => {});
    }
    return sent;
  }

  // ── GROUPS ────────────────────────────────────────────────────

  listenGroup(groupId, cb) {
    this.#grpCbs[groupId] = cb;
    const myUid = Identity.uid();
    const kp    = Identity.kp();
    this.#gun.get('pipchat_grp_presence_' + groupId).set({ uid: myUid, signPub: kp.signPub, ts: Date.now() });
    this.#loadGrpPending(groupId);
    if (this.#grpListening.has(groupId)) return;
    this.#grpListening.add(groupId);
    this.#gun.get('pipchat_grp_presence_' + groupId).map().on((data) => {
      if (!data || !data.uid || data.uid === myUid) return;
      if (!this.#peerGroups[data.uid]) this.#peerGroups[data.uid] = new Set();
      this.#peerGroups[data.uid].add(groupId);
      const ch = this.#channels[data.uid];
      const pc = this.#rtcConns[data.uid];
      if (ch?.readyState === 'open') return;
      if (pc && pc.connectionState !== 'failed' && pc.connectionState !== 'closed') return;
      this.ensureConnected(data.uid);
    });
  }

  ensureConnected(uid) {
    if (this.#channels[uid]?.readyState === 'open') return;
    const existing = this.#rtcConns[uid];
    if (existing) {
      const s = existing.connectionState;
      if (s !== 'failed' && s !== 'closed') return;
      this.#cleanPeer(uid);
    }
    if (Identity.uid() < uid) {
      this.#offer(uid).catch(e => console.error('[WebRTC] offer error:', e));
    } else {
      this.#sig(uid, { type: 'request' });
    }
  }

  async #loadGrpPending(groupId) {
    const items = await Storage.getPending();
    const grpItems = items.filter(i => i.type === 'grp' && i.groupId === groupId);
    if (!grpItems.length) return;
    if (!this.#grpPending[groupId]) this.#grpPending[groupId] = [];
    for (const item of grpItems) {
      if (!this.#grpPending[groupId].find(b => b.id === item.blob.id)) {
        this.#grpPending[groupId].push(item.blob);
        this.#grpPendingIdbIds[item.blob.id] = item.id;
      }
    }
  }

  // ── SIGNAL DEDUP ACROSS RELOADS ──────────────────────────────

  static #LS_SEEN = 'pipchat_seen_sigs';
  static #SEEN_TTL = 120000; // 2 minutes

  #loadPersistedSeen() {
    try {
      const raw = localStorage.getItem(NetworkManager.#LS_SEEN);
      if (!raw) return;
      const map = JSON.parse(raw);
      const now = Date.now();
      for (const [k, ts] of Object.entries(map)) {
        if (now - ts < NetworkManager.#SEEN_TTL) this.#seen.add(k);
      }
    } catch(_) {}
  }

  #persistSeen(key) {
    try {
      const raw = localStorage.getItem(NetworkManager.#LS_SEEN);
      const map = raw ? JSON.parse(raw) : {};
      const now = Date.now();
      map[key] = now;
      // Prune expired entries to keep localStorage lean
      for (const [k, ts] of Object.entries(map)) {
        if (now - ts >= NetworkManager.#SEEN_TTL) delete map[k];
      }
      localStorage.setItem(NetworkManager.#LS_SEEN, JSON.stringify(map));
    } catch(_) {}
  }

  #reannouncePresence() {
    if (!this.#gun || !Identity.uid()) return;
    const kp = Identity.kp();
    for (const groupId of this.#grpListening) {
      this.#gun.get('pipchat_grp_presence_' + groupId).set({ uid: Identity.uid(), signPub: kp.signPub, ts: Date.now() });
    }
  }

  // ── SIGNED PREKEYS ────────────────────────────────────────────

  publishSpk(spk) {
    if (!this.#gun) return;
    console.log('[SPK][PUBLISHED]', spk.pub.slice(0, 12));
    this.#gun.get('pipchat_spk_' + Identity.uid()).put({ spkPub: spk.pub, spkSig: spk.sig, ts: spk.ts });
  }

  async fetchSpk(uid) {
    return new Promise(res => {
      const t = setTimeout(() => res(null), 5000);
      this.#gun.get('pipchat_spk_' + uid).once(d => {
        clearTimeout(t);
        res(d?.spkPub ? { spkPub: d.spkPub, spkSig: d.spkSig, ts: d.ts } : null);
      });
    });
  }

  // ── PROFILES ─────────────────────────────────────────────────

  setDmCallback(cb) { this.#dmCb = cb; }

  async publishProfile(profile) {
    this.#profile = profile;
    if (!this.#gun) return;
    this.#gun.get('pipchat_profiles').get(profile.uid).put(profile);
  }

  async lookupProfile(uid) {
    return new Promise(res => {
      if (!this.#gun) return res(null);
      const t = setTimeout(() => res(null), 5000);
      this.#gun.get('pipchat_profiles').get(uid).once(d => { clearTimeout(t); res(d || null); });
    });
  }
}

const Network = new NetworkManager();
