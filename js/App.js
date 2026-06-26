'use strict';

class PipChatApp {
  #activeDM    = null;
  #activeGroup = null;

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

    // 1. Verify sender identity (signPub must hash to claimed senderId)
    if (blob.senderSignPub) {
      const derivedUid = Crypto.userId(blob.senderSignPub);
      if (derivedUid !== blob.from) return; // identity mismatch

      // 2. Verify signature — required when senderSignPub is present
      if (!blob.sig) {
        await this.#saveAndRender({ id:blob.id||blob.from+'_'+blob.ts, conv:this.#dmConvId(blob.from),
          from:blob.from, text:'[ENCRYPTED MESSAGE — SIGNATURE MISSING]', ts:blob.ts||Date.now(), corrupt:true });
        return;
      }
      const payload = JSON.stringify({ct:blob.ct, nonce:blob.nonce, from:blob.from, to:Identity.uid(), ts:blob.ts});
      if (!Crypto.verify(payload, blob.sig, blob.senderSignPub)) {
        await this.#saveAndRender({ id:blob.id||blob.from+'_'+blob.ts, conv:this.#dmConvId(blob.from),
          from:blob.from, text:'[ENCRYPTED MESSAGE — SIGNATURE INVALID]', ts:blob.ts||Date.now(), corrupt:true });
        return;
      }
    }

    // 3. Get sender boxPub (from blob or contacts)
    let senderBoxPub = blob.senderBoxPub;
    if (!senderBoxPub) {
      const contacts = await Storage.getContacts();
      const c = contacts.find(x => x.userId === blob.from);
      if (c) senderBoxPub = c.boxPub;
    }
    if (!senderBoxPub) return; // can't decrypt

    // 4. Decrypt
    const kp = Identity.kp();
    const plaintext = Crypto.decrypt(blob.ct, blob.nonce, senderBoxPub, kp.boxSec);
    if (plaintext === null) return;

    // Auto-save sender as contact if unknown
    const contacts = await Storage.getContacts();
    if (blob.senderSignPub && !contacts.find(c => c.userId === blob.from)) {
      await Storage.saveContact({
        userId:  blob.from,
        signPub: blob.senderSignPub,
        boxPub:  blob.senderBoxPub || senderBoxPub,
        nick:    null,
        addedAt: Date.now(),
      });
      await UI.renderContacts();
    }

    const msg = { id:blob.id||blob.from+'_'+blob.ts, conv:this.#dmConvId(blob.from),
      from:blob.from, text:plaintext, ts:blob.ts||Date.now() };
    await Storage.saveMessage(msg);

    const isActive = this.#activeDM && this.#activeDM.userId === blob.from;
    const dataVisible = document.getElementById('tab-data')?.classList.contains('active');
    if (isActive) await UI.renderMessages(this.#dmConvId(blob.from));
    if (!isActive || !dataVisible) { Audio.recv(); UI.notify('> INCOMING TRANSMISSION FROM @' + blob.from); }
  }

  // ── INCOMING GROUP MSG ────────────────────────────────────────

  async #handleGroupMsg(blob, group) {
    if (!blob || !blob.ct) return;
    const msgId = blob.id || blob.from+'_'+blob.ts;
    const conv  = this.#grpConvId(group.groupId);

    // Verify sender signature when senderSignPub is present
    if (blob.senderSignPub) {
      const derivedUid = Crypto.userId(blob.senderSignPub);
      if (derivedUid !== blob.from) return; // identity mismatch
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

  // ── PUBLIC CALLBACKS (used from main.js) ─────────────────────

  get dmCallback()       { return this.#handleDM.bind(this); }

  receiveGroupMsg(blob, group) { return this.#handleGroupMsg(blob, group); }

  // ── SEND ─────────────────────────────────────────────────────

  async sendMessage() {
    const input = document.getElementById('msg-input');
    const text  = input.value.trim();
    if (!text) return;
    const kp  = Identity.kp();
    const uid = Identity.uid();

    if (this.#activeDM) {
      const { userId, boxPub } = this.#activeDM;
      let blob, enc;
      try {
        enc = Crypto.encrypt(text, boxPub, kp.boxSec);
        const ts = Date.now();
        const payload = JSON.stringify({ct:enc.ct, nonce:enc.nonce, from:uid, to:userId, ts});
        const sig = Crypto.sign(payload, kp.signSec);
        // ts passed in extraFields overrides makeBlob's internal Date.now() — keeps them in sync
        blob = this.#makeBlob(enc.ct, enc.nonce, { senderSignPub:kp.signPub, senderBoxPub:kp.boxPub, sig, to:userId, ts });
      } catch(e) { Audio.error(); UI.notify(PIP.cryptoErr,'err'); return; }

      const msg = { id:blob.id, conv:this.#dmConvId(userId), from:uid, text, ts:blob.ts };
      await Storage.saveMessage(msg);
      await UI.renderMessages(this.#dmConvId(userId));

      const sent = await Network.sendDM(userId, blob);
      if (!sent) {
        msg.pending = true;
        await Storage.saveMessage(msg);
        await UI.renderMessages(this.#dmConvId(userId));
        UI.notify(PIP.queued,'warn');
      } else {
        Audio.send(); UI.notify(PIP.sent);
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
    UI.openChat('@' + contact.userId + (contact.nick ? ' · ' + contact.nick : ''));
    UI.switchTab('data');
    await UI.renderMessages(this.#dmConvId(contact.userId));
    // Refresh nick in background
    Network.lookupProfile(contact.userId).then(async profile => {
      if (profile?.nick && profile.nick !== contact.nick) {
        contact.nick = profile.nick;
        await Storage.saveContact(contact);
        await UI.renderContacts();
        UI.openChat('@' + contact.userId + ' · ' + contact.nick);
      }
    });
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

    // Handle pipchat share links: ...#id=KEY&nick=NICK
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
    await Network.publishGroupInfo(groupId, { groupId, name, createdBy:group.createdBy });

    const inviteCode = groupId + '|' + groupKey;
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
    const [groupId, groupKey] = val.split('|');
    if (!groupId || !groupKey) { Audio.error(); UI.notify('> ERROR: MALFORMED INVITE CODE','err'); return; }

    const existing = await Storage.getGroups();
    if (existing.find(g => g.groupId === groupId)) { UI.notify('> ALREADY A MEMBER OF THIS CHANNEL','warn'); return; }

    const info  = await Network.lookupGroupInfo(groupId) || {};
    const group = { groupId, name:info.name || groupId.slice(0,8).toUpperCase(),
      groupKey, members:info.members||'?', joinedAt:Date.now() };

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
        await Storage.saveContact(c);
        await UI.renderContacts();
        UI.notify('> DESIGNATION UPDATED');
      }},
      { label:'CANCEL', cls:'', action: ()=>{} },
    ]);
  }
}

const App = new PipChatApp();
