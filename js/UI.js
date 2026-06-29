'use strict';

class UIManager {
  #notTimer = null;
  #BOOT = [
    '>  INITIALIZING LU MULUTU INC. COMMUNICATIONS...',
    '>  LOADING CRYPTOGRAPHIC MODULES.............. OK',
    '>  GENERATING SECURE CHANNEL.................. OK',
    '>  CONNECTING TO SANTA CHIARA NETWORK............ OK',
    '>  SCANNING FOR KNOWN MULUTI................ OK',
    '>  NO GOVERNMENT BACKDOORS DETECTED........... OK',
    '>  ANONYMITY PROTOCOLS ACTIVE................. OK',
    '',
    'WELCOME BACK, VAULT DWELLER.',
    'YOUR IDENTITY IS YOUR OWN.',
  ];

  async bootSequence() {
    const container = document.getElementById('boot-lines');
    for (const line of this.#BOOT) {
      await delay(120);
      const s = document.createElement('span');
      s.className = 'boot-line glow';
      if (!line) { s.innerHTML = '&nbsp;'; container.appendChild(s); continue; }
      if (line.startsWith('WELCOME') || line.startsWith('YOUR')) {
        s.classList.add('end'); s.textContent = line; container.appendChild(s); continue;
      }
      container.appendChild(s);
      for (const ch of line) { await delay(10); s.textContent += ch; }
    }
    await delay(400);
    document.getElementById('boot-overlay').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
  }

  notify(text, type = 'info') {
    const el = document.getElementById('notification');
    el.textContent = text;
    el.className = 'show' + (type==='warn'?' warn' : type==='err'?' err' : '');
    if (this.#notTimer) clearTimeout(this.#notTimer);
    this.#notTimer = setTimeout(() => el.className = '', 3500);
  }

  connStatus(isOnline, peerCnt) {
    const dot = document.getElementById('conn-dot');
    const lbl = document.getElementById('conn-lbl');
    const st  = document.getElementById('s-status');
    const pe  = document.getElementById('s-peers');
    dot.className = 'conn-dot' + (isOnline ? '' : ' off');
    lbl.textContent = isOnline ? 'CONNECTED' : 'OFFLINE';
    if (st) st.textContent = isOnline ? 'ONLINE' : 'OFFLINE — NO SIGNAL';
    if (pe) pe.textContent = peerCnt + ' CONNECTED';
  }

  renderIdentity(kp) {
    document.getElementById('s-uid').textContent    = '@' + Identity.uid();
    document.getElementById('s-pubkey').textContent = kp.signPub;
  }

  setNick(nick) {
    document.getElementById('s-nick').textContent = nick || 'UNKNOWN';
    if (nick) document.getElementById('nick-input').value = nick;
  }

  async renderContacts() {
    const list = await Storage.getContacts();
    const el   = document.getElementById('contacts-list');
    if (!list.length) {
      el.innerHTML = '<div style="color:var(--pip-green-dim);font-size:12px;text-align:center;padding:20px 0">NO KNOWN DWELLERS IN DATABASE</div>';
      return;
    }
    el.innerHTML = '';
    list.forEach(c => {
      const div = document.createElement('div');
      div.className = 'contact-item';
      div.innerHTML = `
        <div style="min-width:0;flex:1">
          <div class="c-name">${esc(c.nick||'UNKNOWN VAULT DWELLER')}</div>
          <div class="c-sub">> @${esc(c.userId)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="pip-btn sm" data-action="rename">NICK</button>
          <button class="pip-btn sm" data-action="msg">MSG</button>
          <button class="pip-btn sm danger" data-action="del">[X]</button>
        </div>`;
      div.querySelector('[data-action="msg"]').addEventListener('click', e => {
        e.stopPropagation(); Audio.click(); App.openDM(c);
      });
      div.querySelector('[data-action="rename"]').addEventListener('click', e => {
        e.stopPropagation(); Audio.click(); App.renameContact(c);
      });
      div.querySelector('[data-action="del"]').addEventListener('click', e => {
        e.stopPropagation(); Audio.click(); App.deleteContact(c);
      });
      div.addEventListener('click', () => { Audio.click(); App.openDM(c); });
      el.appendChild(div);
    });
  }

  async renderGroups() {
    const list = await Storage.getGroups();
    const el   = document.getElementById('groups-list');
    if (!list.length) {
      el.innerHTML = '<div style="color:var(--pip-green-dim);font-size:12px;text-align:center;padding:20px 0">NO ACTIVE CHANNELS</div>';
      return;
    }
    el.innerHTML = '';
    list.forEach(g => {
      const div = document.createElement('div');
      div.className = 'group-item';
      div.innerHTML = `
        <div>
          <div class="c-name">#${esc(g.name)}</div>
          <div class="c-sub">> ${esc(String(g.members||1))} MEMBER(S) — ID: ${esc(g.groupId).slice(0,10)}...</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="pip-btn sm">[>>]</button>
          <button class="pip-btn sm danger">[X]</button>
        </div>`;
      const btns = div.querySelectorAll('.pip-btn');
      btns[0].addEventListener('click', e => { e.stopPropagation(); Audio.click(); App.openGroup(g); });
      btns[1].addEventListener('click', e => { e.stopPropagation(); Audio.click(); App.leaveGroup(g); });
      div.addEventListener('click', () => { Audio.click(); App.openGroup(g); });
      el.appendChild(div);
    });
  }

  // Opens a group chat (no DM mode bar)
  openChat(title) {
    document.getElementById('no-chat').style.display   = 'none';
    document.getElementById('chat-view').style.display = 'block';
    document.getElementById('chat-title').textContent  = title;
    document.getElementById('msg-bar').className = 'on';
    const bar = document.getElementById('dm-mode-bar');
    if (bar) bar.remove();
  }

  // Opens a 1-1 DM chat with relay/direct mode indicator
  openDMChat(contact, mode) {
    const label = '@' + contact.userId + (contact.nick ? ' · ' + contact.nick : '');
    document.getElementById('no-chat').style.display   = 'none';
    document.getElementById('chat-view').style.display = 'block';
    document.getElementById('chat-title').textContent  = label;
    document.getElementById('msg-bar').className = 'on';
    this.#ensureDmModeBar();
    this.updateDmMode(mode || 'relay');
  }

  #ensureDmModeBar() {
    if (document.getElementById('dm-mode-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'dm-mode-bar';
    const chatHdr = document.getElementById('chat-hdr');
    chatHdr.insertAdjacentElement('afterend', bar);
  }

  updateDmMode(mode) {
    const bar = document.getElementById('dm-mode-bar');
    if (!bar) return;
    if (mode === 'direct') {
      bar.innerHTML = '<span class="mode-badge direct">DIRECT LINK</span>' +
        '<button class="pip-btn sm danger" onclick="App.closeDirectConnection()">[CLOSE DIRECT]</button>';
    } else if (mode === 'requesting') {
      bar.innerHTML = '<span class="mode-badge requesting">DIRECT REQUEST PENDING...</span>';
    } else if (mode === 'connecting') {
      bar.innerHTML = '<span class="mode-badge connecting">ESTABLISHING DIRECT LINK...</span>';
    } else {
      bar.innerHTML = '<span class="mode-badge relay">RELAY</span>' +
        '<button class="pip-btn sm" onclick="App.requestDirectConnection()">[REQUEST DIRECT]</button>';
    }
  }

  async renderMessages(conv) {
    const msgs  = await Storage.getMessages(conv);
    const el    = document.getElementById('messages-list');
    el.innerHTML = '';
    const myUid = Identity.uid();
    msgs.forEach(m => {
      const isMe = m.from === myUid;
      const div  = document.createElement('div');
      div.className = 'msg' +
        (m.pending   ? ' pending'   : '') +
        (m.failed    ? ' failed'    : '') +
        (m.corrupt   ? ' corrupted' : '');
      const t = new Date(m.ts).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      div.innerHTML = `
        <div class="msg-hdr ${isMe?'mine':''}">
          <span style="color:var(--pip-green-dim)">></span>
          <span class="sender"> ${isMe?'YOU':'@'+esc(m.from)}</span>
          <span style="color:var(--pip-green-dim)"> [${t}]</span>
        </div>
        <div class="msg-body">${esc(m.text)}</div>`;
      el.appendChild(div);
    });
    el.scrollTop = el.scrollHeight;
  }

  switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id==='tab-'+tab));
    if (tab !== 'data') {
      document.getElementById('msg-bar').className = '';
    } else {
      const chatVisible = document.getElementById('chat-view').style.display !== 'none';
      if (chatVisible) document.getElementById('msg-bar').className = 'on';
    }
  }
}

const UI = new UIManager();
