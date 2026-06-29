'use strict';

class PipChatApp {
  #activeDM    = null;
  #activeGroup = null;
  #prevDmMode  = {};  // uid → last notified mode (to avoid spurious "relay" notifications)

  // ── PRIVATE HELPERS ──────────────────────────────────────────

  #dmConvId(uid)  { return 'dm_'  + uid; }
  #grpConvId(gid) { return 'grp_' + gid; }

  #makeBlob(ct, nonce, extraFields) {
    return {
      id:   Identity.uid() + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      from: Identity.uid(),
      ct, nonce,
      ts:   Date.now(),
      ...extraFields,
    };
  }

  // ── INCOMING DM ──────────────────────────────────────────────

  async #handleDM(blob) {
    if (!blob || !blob.ct) return;
    // Gun delivers nested objects as references — ratchet header is serialized as a string
    const r = typeof blob.ratchet === 'string' ? (() => { try { return JSON.parse(blob.ratchet); } catch(_) { return null; } })() : null;
    if (r) { await this.#handleDMRatchet(blob, r); return; }
    await this.#handleDMLegacy(blob);
  }

  // Ratchet path: sender identity is inside the ciphertext
  async #handleDMRatchet(blob, r) {
    const senderUid = blob.from;

    if (r.type === 'x3dh') {
      const existing = await Storage.getRatchetState(senderUid);
      if (!existing || existing.sessionId !== r.ekPub) {
        const mySpk = await Storage.getMySpk();
        if (!mySpk || !r.senderBoxPub) {
          console.warn('[X3DH][RECV] missing SPK or senderBoxPub from', senderUid.slice(0, 8));
          return;
        }
        const kp  = Identity.kp();
        const dh1 = Crypto.dh(mySpk.sec, r.senderBoxPub);  // SPK_B × IK_A
        const dh2 = Crypto.dh(kp.boxSec, r.ekPub);         // IK_B × EK_A
        const dh3 = Crypto.dh(mySpk.sec, r.ekPub);         // SPK_B × EK_A
        await Ratchet.initSession(senderUid, Crypto.x3dhSecret(dh1, dh2, dh3), false, r.ekPub);
        console.log('[X3DH][RECV] session from', senderUid.slice(0, 8));
      }
    }

    let inner;
    try { inner = await Ratchet.decrypt(senderUid, blob.ct, blob.nonce, r.msgNum); }
    catch(e) { console.warn('[RATCHET] decrypt error:', e.message); return; }
    if (!inner) return;

    if (!inner.senderSignPub || Crypto.userId(inner.senderSignPub) !== senderUid) return;
    const sigPayload = JSON.stringify({ text: inner.text, senderSignPub: inner.senderSignPub, senderBoxPub: inner.senderBoxPub });
    if (!Crypto.verify(sigPayload, inner.sig, inner.senderSignPub)) return;

    const contacts = await Storage.getContacts();
    if (!contacts.find(c => c.userId === senderUid) && inner.senderSignPub) {
      await Storage.saveContact({ userId: senderUid, signPub: inner.senderSignPub, boxPub: inner.senderBoxPub, addedAt: Date.now() });
      await UI.renderContacts();
    }

    await this.#deliverDM(senderUid, inner.text, blob.id, blob.ts);
  }

  // Legacy path: sender identity in plaintext blob fields
  async #handleDMLegacy(blob) {
    if (blob.senderSignPub) {
      if (Crypto.userId(blob.senderSignPub) !== blob.from) return;
      if (!blob.sig) {
        await this.#saveAndRender({ id:blob.id||blob.from+'_'+blob.ts, conv:this.#dmConvId(blob.from),
          from:blob.from, text:'[ENCRYPTED MESSAGE — SIGNATURE MISSING]', ts:blob.ts||Date.now(), corrupt:true });
        return;
      }
      const newPayload    = JSON.stringify({ ct: blob.ct, nonce: blob.nonce, from: blob.from, ts: blob.ts });
      const legacyPayload = JSON.stringify({ ct: blob.ct, nonce: blob.nonce, from: blob.from, to: Identity.uid(), ts: blob.ts });
      if (!Crypto.verify(newPayload, blob.sig, blob.senderSignPub) &&
          !Crypto.verify(legacyPayload, blob.sig, blob.senderSignPub)) {
        await this.#saveAndRender({ id:blob.id||blob.from+'_'+blob.ts, conv:this.#dmConvId(blob.from),
          from:blob.from, text:'[ENCRYPTED MESSAGE — SIGNATURE INVALID]', ts:blob.ts||Date.now(), corrupt:true });
        return;
      }
    }

    let senderBoxPub = blob.senderBoxPub;
    if (!senderBoxPub) {
      const c = (await Storage.getContacts()).find(x => x.userId === blob.from);
      if (c) senderBoxPub = c.boxPub;
    }
    if (!senderBoxPub) return;

    const kp = Identity.kp();
    let plaintext = null;
    if (blob.senderEphemBoxPub) plaintext = Crypto.decrypt(blob.ct, blob.nonce, blob.senderEphemBoxPub, kp.boxSec);
    if (plaintext === null)      plaintext = Crypto.decrypt(blob.ct, blob.nonce, senderBoxPub, kp.boxSec);
    if (plaintext === null) return;

    const contacts = await Storage.getContacts();
    if (!contacts.find(c => c.userId === blob.from) && blob.senderSignPub) {
      await Storage.saveContact({ userId: blob.from, signPub: blob.senderSignPub, boxPub: blob.senderBoxPub || senderBoxPub, addedAt: Date.now() });
      await UI.renderContacts();
    }

    await this.#deliverDM(blob.from, plaintext, blob.id, blob.ts);
  }

  async #deliverDM(senderUid, plaintext, blobId, blobTs) {
    const msgId = blobId || senderUid + '_' + blobTs;
    const msg   = { id: msgId, conv: this.#dmConvId(senderUid), from: senderUid, text: plaintext, ts: blobTs || Date.now() };
    const inDb  = await Storage.getMessage(msgId);
    await Storage.saveMessage(msg);
    if (inDb) return;

    const isActive    = this.#activeDM && this.#activeDM.userId === senderUid;
    const dataVisible = document.getElementById('tab-data')?.classList.contains('active');
    if (isActive) await UI.renderMessages(this.#dmConvId(senderUid));
    if (!isActive || !dataVisible) {
      const sender = (await Storage.getContacts()).find(c => c.userId === senderUid);
      Audio.recv(); UI.notify('> INCOMING TRANSMISSION FROM ' + (sender?.nick || ('@' + senderUid)));
    }
  }

  // ── INCOMING GROUP MSG ────────────────────────────────────────

  async #handleGroupMsg(blob, group) {
    if (!blob || !blob.ct) return;
    const msgId = blob.id || blob.from+'_'+blob.ts;
    const conv  = this.#grpConvId(group.groupId);

    if (blob.senderSignPub) {
      const derivedUid = Crypto.userId(blob.senderSignPub);
      if (derivedUid !== blob.from) return;
      if (!blob.sig) {
        await this.#saveAndRender({ id:msgId, conv, from:blob.from,
          text:'[GROUP MESSAGE — SIGNATURE MISSING]', ts:blob.ts||Date.now(), corrupt:true });
        return;
      }
      const grpPayload = JSON.stringify({ct:blob.ct, nonce:blob.nonce, from:blob.from, grp:group.groupId, ts:blob.ts});
      if (!Crypto.verify(grpPayload, blob.sig, blob.senderSignPub)) {
        await this.#saveAndRender({ id:msgId, conv, from:blob.from,
          text:'[GROUP MESSAGE — SIGNATURE INVALID]', ts:blob.ts||Date.now(), corrupt:true });
        return;
      }
    }

    const text = Crypto.decryptSym(blob.ct, blob.nonce, group.groupKey);
    if (!text) return;
    const msg = { id:msgId, conv, from:blob.from, text, ts:blob.ts||Date.now() };
    await Storage.saveMessage(msg);
    const isActive = this.#activeGroup && this.#activeGroup.groupId === group.groupId;
    const dataVisible = document.getElementById('tab-data')?.classList.contains('active');
    if (isActive) await UI.renderMessages(conv);
    if (!isActive || !dataVisible) { Audio.recv(); UI.notify('> INCOMING TRANSMISSION IN #' + group.name); }
  }

  async #saveAndRender(msg) {
    await Storage.saveMessage(msg);
    if (this.#activeDM    && this.#dmConvId(this.#activeDM.userId)       === msg.conv) await UI.renderMessages(msg.conv);
    if (this.#activeGroup && this.#grpConvId(this.#activeGroup.groupId) === msg.conv) await UI.renderMessages(msg.conv);
  }

  // ── DM MODE CALLBACKS ────────────────────────────────────────

  #dmModeChangedCb = async (uid, mode) => {
    const prev = this.#prevDmMode[uid] || 'relay';
    this.#prevDmMode[uid] = (mode === 'rejected') ? 'relay' : mode;

    if (this.#activeDM?.userId === uid) {
      UI.updateDmMode(mode === 'rejected' ? 'relay' : mode);
    }

    if (mode === 'direct') {
      Audio.recv();
      UI.notify('> DIRECT LINK ESTABLISHED — PEER-TO-PEER ACTIVE');
      // Auto-open chat for the side that accepted (doesn't have the DM open yet)
      if (!this.#activeDM || this.#activeDM.userId !== uid) {
        const contacts = await Storage.getContacts();
        const contact  = contacts.find(c => c.userId === uid);
        if (contact) await this.openDM(contact);
      }
    } else if (mode === 'relay' && (prev === 'direct' || prev === 'connecting')) {
      UI.notify('> DIRECT LINK TERMINATED — RETURNING TO RELAY', 'warn');
    } else if (mode === 'rejected') {
      UI.notify('> DIRECT LINK REQUEST REJECTED', 'warn');
    } else if (mode === 'requesting') {
      UI.notify('> DIRECT LINK REQUEST SENT — AWAITING CONFIRMATION', 'warn');
    }
  };

  #dmRequestCb = async (fromUid) => {
    const contacts = await Storage.getContacts();
    const contact  = contacts.find(c => c.userId === fromUid);
    const label    = contact?.nick || ('@' + fromUid);
    Audio.recv();
    UI.notify('> INCOMING DIRECT LINK REQUEST FROM ' + label, 'warn');
    showModal('DIRECT LINK REQUEST', [
      `<strong>${esc(label)}</strong> is requesting a direct peer-to-peer connection.`,
      'Accept to communicate without the relay server.',
      '<span style="color:var(--pip-green-dim);font-size:11px">You can close the direct link at any time.</span>',
    ], [
      { label: 'ACCEPT', cls: '', action: () => { Audio.click(); Network.acceptDirect(fromUid); } },
      { label: 'REJECT', cls: 'danger', action: () => { Audio.click(); Network.rejectDirect(fromUid); } },
    ]);
  };

  get dmModeChangedCallback() { return this.#dmModeChangedCb; }
  get dmRequestCallback()     { return this.#dmRequestCb; }

  // ── PUBLIC CALLBACKS (used from main.js) ─────────────────────

  get dmCallback()       { return this.#handleDM.bind(this); }

  receiveGroupMsg(blob, group) { return this.#handleGroupMsg(blob, group); }

  // ── DIRECT CONNECTION CONTROLS ───────────────────────────────

  requestDirectConnection() {
    if (!this.#activeDM) return;
    Audio.click();
    Network.requestDirect(this.#activeDM.userId);
  }

  closeDirectConnection() {
    if (!this.#activeDM) return;
    Audio.click();
    Network.closeDirect(this.#activeDM.userId);
  }

  // ── ENCRYPTION HELPERS ───────────────────────────────────────

  // Try ratchet (X3DH init or existing session), fallback to legacy ephemeral.
  async #dmEncrypt(userId, boxPub, signPub, text) {
    const ts  = Date.now();
    const kp  = Identity.kp();

    // 1 — existing session → ratchet message
    if (await Ratchet.hasSession(userId)) {
      const inner = this.#signedInner(text, kp);
      const { ct, nonce, msgNum } = await Ratchet.encrypt(userId, inner);
      return this.#makeBlob(ct, nonce, { ts, expires: ts + 7*24*60*60*1000,
        ratchet: JSON.stringify({ type: 'ratchet', msgNum }) });
    }

    // 2 — no session: try X3DH
    const theirSpk = await Network.fetchSpk(userId);
    if (theirSpk && Crypto.verify(theirSpk.spkPub, theirSpk.spkSig, signPub)) {
      const ekKp   = Crypto.generateBoxKeypair();
      const dh1    = Crypto.dh(kp.boxSec,    theirSpk.spkPub);  // IK_A × SPK_B
      const dh2    = Crypto.dh(ekKp.boxSec,  boxPub);           // EK_A × IK_B
      const dh3    = Crypto.dh(ekKp.boxSec,  theirSpk.spkPub);  // EK_A × SPK_B
      await Ratchet.initSession(userId, Crypto.x3dhSecret(dh1, dh2, dh3), true, ekKp.boxPub);
      console.log('[X3DH][INIT] session with', userId.slice(0, 8));
      const inner = this.#signedInner(text, kp);
      const { ct, nonce, msgNum } = await Ratchet.encrypt(userId, inner);
      return this.#makeBlob(ct, nonce, {
        ts, expires: ts + 7*24*60*60*1000,
        ratchet: JSON.stringify({ type: 'x3dh', ekPub: ekKp.boxPub, senderBoxPub: kp.boxPub, msgNum }),
      });
    }

    // 3 — no SPK available: legacy ephemeral scheme
    return this.#legacyEncrypt(text, boxPub, ts, kp);
  }

  // Inner plaintext for ratchet: identity + sig inside CT (relay never sees them)
  #signedInner(text, kp) {
    const inner = { text, senderSignPub: kp.signPub, senderBoxPub: kp.boxPub };
    inner.sig   = Crypto.sign(JSON.stringify({ text, senderSignPub: kp.signPub, senderBoxPub: kp.boxPub }), kp.signSec);
    return inner;
  }

  // Legacy: senderSignPub/BoxPub visible in blob (used when peer has no SPK)
  #legacyEncrypt(text, boxPub, ts, kp) {
    const myEphem = Network.ephemKp;
    const enc     = Crypto.encrypt(text, boxPub, myEphem ? myEphem.boxSec : kp.boxSec);
    const payload = JSON.stringify({ ct: enc.ct, nonce: enc.nonce, from: Identity.uid(), ts });
    const sig     = Crypto.sign(payload, kp.signSec);
    const extra   = { senderSignPub: kp.signPub, senderBoxPub: kp.boxPub, sig, ts, expires: ts + 7*24*60*60*1000 };
    if (myEphem) extra.senderEphemBoxPub = myEphem.boxPub;
    console.log('[DM][LEGACY] encrypting — peer has no SPK');
    return this.#makeBlob(enc.ct, enc.nonce, extra);
  }

  // ── SEND ─────────────────────────────────────────────────────

  async sendMessage() {
    const input = document.getElementById('msg-input');
    const text  = input.value.trim();
    if (!text) return;
    const kp  = Identity.kp();
    const uid = Identity.uid();

    if (this.#activeDM) {
      const { userId, boxPub, signPub } = this.#activeDM;
      let blob;
      try {
        blob = await this.#dmEncrypt(userId, boxPub, signPub, text);
      } catch(e) { Audio.error(); UI.notify(PIP.cryptoErr,'err'); return; }

      const msg = { id:blob.id, conv:this.#dmConvId(userId), from:uid, text, ts:blob.ts };
      await Storage.saveMessage(msg);
      await UI.renderMessages(this.#dmConvId(userId));

      const sent = await Network.sendDM(userId, blob);
      if (sent === 'failed') {
        msg.failed = true;
        await Storage.saveMessage(msg);
        await UI.renderMessages(this.#dmConvId(userId));
        Audio.error();
        UI.notify(PIP.rtcFailed, 'err');
      } else if (sent === 'queued') {
        Audio.send();
        UI.notify(PIP.queued, 'warn');
      } else {
        Audio.send();
        UI.notify(PIP.sent);
      }

    } else if (this.#activeGroup) {
      const enc  = Crypto.encryptSym(text, this.#activeGroup.groupKey);
      const ts   = Date.now();
      const grpPayload = JSON.stringify({ct:enc.ct, nonce:enc.nonce, from:uid, grp:this.#activeGroup.groupId, ts});
      const sig  = Crypto.sign(grpPayload, kp.signSec);
      const blob = this.#makeBlob(enc.ct, enc.nonce, { senderSignPub:kp.signPub, sig, ts });
      const msg  = { id:blob.id, conv:this.#grpConvId(this.#activeGroup.groupId), from:uid, text, ts:blob.ts };
      await Storage.saveMessage(msg);
      await Network.sendGroup(this.#activeGroup.groupId, blob);
      await UI.renderMessages(this.#grpConvId(this.#activeGroup.groupId));
      Audio.send();
    }

    input.value = '';
  }

  // ── OPEN DM / GROUP ──────────────────────────────────────────

  async openDM(contact) {
    this.#activeDM    = contact;
    this.#activeGroup = null;
    UI.switchTab('data');
    UI.openDMChat(contact, Network.getDmMode(contact.userId));
    await UI.renderMessages(this.#dmConvId(contact.userId));
  }

  async openGroup(group) {
    this.#activeGroup = group;
    this.#activeDM    = null;
    UI.openChat('#' + group.name);
    UI.switchTab('data');
    await UI.renderMessages(this.#grpConvId(group.groupId));
    Network.listenGroup(group.groupId, blob => this.#handleGroupMsg(blob, group));
  }

  // ── CONTACTS ─────────────────────────────────────────────────

  toggleAddContact() {
    Audio.click();
    const f = document.getElementById('add-contact-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
  }

  async addContact() {
    Audio.click();
    let val = document.getElementById('contact-input').value.trim();

    if (val.includes('id=')) {
      const m = val.match(/[#?&]id=([^&\s]+)/);
      if (m) val = decodeURIComponent(m[1]);
    }

    if (!val || val.length < 20) { Audio.error(); UI.notify('> ERROR: INVALID PUBLIC KEY FORMAT','err'); return; }

    try {
      const userId  = Crypto.userId(val);
      const boxPub  = Crypto.toCurvePub(val);
      const profile = await Network.lookupProfile(userId);
      const contact = { userId, signPub:val, boxPub, nick:profile?.nick||null, addedAt:Date.now() };
      await Storage.saveContact(contact);
      await UI.renderContacts();
      document.getElementById('contact-input').value = '';
      document.getElementById('add-contact-form').style.display = 'none';
      UI.notify(PIP.added);
    } catch(e) { Audio.error(); UI.notify('> ERROR: ' + e.message,'err'); }
  }

  // ── GROUPS ───────────────────────────────────────────────────

  toggleCreateGroup() {
    Audio.click();
    const f = document.getElementById('create-group-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
  }

  async createGroup() {
    Audio.click();
    const raw  = document.getElementById('group-name-input').value.trim();
    const name = raw.toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,20);
    if (!name) { Audio.error(); UI.notify('> ERROR: CHANNEL NAME REQUIRED','err'); return; }

    const groupId  = Identity.uid() + '_' + Date.now().toString(36);
    const groupKey = Crypto.genGroupKey();
    const group    = { groupId, name, groupKey, members:1, createdBy:Identity.uid(), createdAt:Date.now() };

    await Storage.saveGroup(group);

    const inviteCode = groupId + '|' + groupKey + '|' + name;
    showModal('CHANNEL ESTABLISHED', [
      `Channel <strong>${name}</strong> created.`,
      'Share this invite code with members:',
      `<div class="id-value" style="margin-top:8px;font-size:10px;word-break:break-all">${esc(inviteCode)}</div>`,
    ], [
      { label:'COPY CODE', cls:'', action: () => { Audio.click(); navigator.clipboard.writeText(inviteCode).catch(()=>{}); }},
      { label:'CLOSE',     cls:'', action: ()=>{} },
    ]);

    document.getElementById('group-name-input').value = '';
    document.getElementById('create-group-form').style.display = 'none';
    await UI.renderGroups();
    Network.listenGroup(groupId, blob => this.#handleGroupMsg(blob, group));
    UI.notify(PIP.grpNew);
  }

  async joinGroup() {
    Audio.click();
    const val = document.getElementById('group-invite-input').value.trim();
    if (!val.includes('|')) { Audio.error(); UI.notify('> ERROR: INVALID INVITE CODE','err'); return; }
    const [groupId, groupKey, groupName] = val.split('|');
    if (!groupId || !groupKey) { Audio.error(); UI.notify('> ERROR: MALFORMED INVITE CODE','err'); return; }

    const existing = await Storage.getGroups();
    if (existing.find(g => g.groupId === groupId)) { UI.notify('> ALREADY A MEMBER OF THIS CHANNEL','warn'); return; }

    const group = { groupId, name: groupName || groupId.slice(0,8).toUpperCase(),
      groupKey, joinedAt:Date.now() };

    await Storage.saveGroup(group);
    await UI.renderGroups();
    document.getElementById('group-invite-input').value = '';
    Network.listenGroup(groupId, blob => this.#handleGroupMsg(blob, group));
    UI.notify('> CHANNEL JOINED SUCCESSFULLY');
  }

  async leaveGroup(group) {
    Audio.click();
    showModal('LEAVE CHANNEL', [
      `Leave channel <strong>#${esc(group.name)}</strong>?`,
      '<span style="color:var(--pip-green-dim);font-size:11px">Your messages will remain on the network.</span>',
    ], [
      { label:'CONFIRM LEAVE', cls:'danger', action: async () => {
        await Storage.delGroup(group.groupId);
        await UI.renderGroups();
        if (this.#activeGroup && this.#activeGroup.groupId === group.groupId) {
          this.#activeGroup = null;
          document.getElementById('no-chat').style.display  = 'block';
          document.getElementById('chat-view').style.display = 'none';
          document.getElementById('msg-bar').className = '';
        }
        UI.notify(PIP.grpLeft,'warn');
      }},
      { label:'ABORT', cls:'', action: ()=>{} },
    ]);
  }

  // ── SETTINGS ACTIONS ─────────────────────────────────────────

  copyKey() {
    Audio.click();
    const k = Identity.signPub();
    if (!k) return;
    navigator.clipboard.writeText(k)
      .then(() => UI.notify('> PUBLIC KEY COPIED TO CLIPBOARD'))
      .catch(() => UI.notify('> COPY FAILED — SELECT KEY MANUALLY','warn'));
  }

  shareLink() {
    Audio.click();
    const k    = Identity.signPub();
    const nick = document.getElementById('nick-input').value.trim();
    const base = location.href.split('#')[0];
    const url  = base + '#id=' + encodeURIComponent(k) + (nick ? '&nick=' + encodeURIComponent(nick) : '');
    navigator.clipboard.writeText(url)
      .then(() => UI.notify('> SHARE LINK COPIED TO CLIPBOARD'))
      .catch(() => UI.notify('> COPY FAILED','warn'));
  }

  async exportBackup() {
    Audio.click();
    const b64 = await Identity.export();
    if (!b64) return;
    const blob = new Blob([b64], {type:'text/plain'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'pipchat_backup_' + Identity.uid() + '.txt';
    a.click(); URL.revokeObjectURL(url);
    UI.notify('> IDENTITY BACKUP EXPORTED');
  }

  showImport() {
    Audio.click();
    showModal('IMPORT IDENTITY', [
      'Paste your backup code below.',
      '<textarea id="import-ta" class="pip-input" rows="4" style="resize:vertical;min-height:80px;margin-top:8px"></textarea>',
    ], [
      { label:'IMPORT', cls:'', action: async () => {
        const val = document.getElementById('import-ta')?.value.trim();
        if (!val) return;
        const ok = await Identity.import(val);
        if (ok) { UI.renderIdentity(Identity.kp()); UI.notify(PIP.idLoaded); }
        else { Audio.error(); UI.notify('> ERROR: INVALID BACKUP FORMAT','err'); }
      }},
      { label:'CANCEL', cls:'', action: ()=>{} },
    ]);
  }

  confirmDestroy() {
    Audio.error();
    showModal('!! DESTROY IDENTITY !!', [
      '<span style="color:var(--pip-red)">WARNING: THIS WILL PERMANENTLY DELETE YOUR VAULT IDENTITY AND ALL LOCAL DATA.</span>',
      '<br>This action cannot be undone.',
    ], [
      { label:'!! CONFIRM DESTROY !!', cls:'danger', action: async () => {
        await Identity.destroy(); location.reload();
      }},
      { label:'ABORT', cls:'', action: ()=>{} },
    ], 'red');
  }

  deleteContact(c) {
    showModal('REMOVE DWELLER', [
      `Remove <strong>@${esc(c.userId)}</strong> from your database?`,
      '<span style="color:var(--pip-green-dim);font-size:11px">Message history is kept locally.</span>',
    ], [
      { label:'CONFIRM REMOVE', cls:'danger', action: async () => {
        if (Network.getDmMode(c.userId) === 'direct') Network.closeDirect(c.userId);
        await Storage.delContact(c.userId);
        if (this.#activeDM && this.#activeDM.userId === c.userId) {
          this.#activeDM = null;
          document.getElementById('no-chat').style.display  = 'block';
          document.getElementById('chat-view').style.display = 'none';
          document.getElementById('msg-bar').className = '';
        }
        await UI.renderContacts();
        UI.notify('> DWELLER REMOVED FROM DATABASE','warn');
      }},
      { label:'ABORT', cls:'', action: ()=>{} },
    ]);
  }

  renameContact(c) {
    showModal('SET DESIGNATION', [
      `Set nickname for <strong>@${esc(c.userId)}</strong>:`,
      `<input type="text" id="rename-ta" class="pip-input" maxlength="20" value="${esc(c.nick||'')}" placeholder="> DESIGNATION..." style="margin-top:8px">`,
    ], [
      { label:'SAVE', cls:'', action: async () => {
        const val = document.getElementById('rename-ta')?.value.trim() || null;
        c.nick = val;
        c.nickIsLocal = !!val;
        await Storage.saveContact(c);
        await UI.renderContacts();
        UI.notify('> DESIGNATION UPDATED');
      }},
      { label:'CANCEL', cls:'', action: ()=>{} },
    ]);
  }
}

const App = new PipChatApp();
