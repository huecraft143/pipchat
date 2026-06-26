'use strict';

async function init() {
  // CDN scripts (libsodium, Gun) are blocked by browsers from file:// origins.
  if (location.protocol === 'file:') {
    document.getElementById('boot-overlay').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    UI.notify('> ERROR: OPEN VIA HTTP — RUN: npx serve .  OR  python -m http.server', 'err');
    return;
  }
  try {
    // Start boot sequence and crypto init in parallel
    const bootP   = UI.bootSequence();
    const cryptoP = Crypto.init();
    await cryptoP;

    // Identity
    const isNew = await Identity.init();
    await bootP; // wait for boot animation

    // Render identity in settings panel
    UI.renderIdentity(Identity.kp());

    // Nick
    const nick = await Storage.getSetting('nick');
    if (nick) UI.setNick(nick);
    document.getElementById('nick-input').addEventListener('change', async e => {
      const v = e.target.value.trim();
      await Storage.saveSetting('nick', v);
      UI.setNick(v);
      await Network.publishProfile({ uid:Identity.uid(), nick:v, signPub:Identity.signPub(), boxPub:Identity.boxPub() });
    });

    // Network
    await Network.init();
    Network.setDmCallback(App.dmCallback);
    Network.startListening();
    await Network.publishProfile({ uid:Identity.uid(), nick:nick||null, signPub:Identity.signPub(), boxPub:Identity.boxPub() });

    UI.notify(isNew ? PIP.idNew : PIP.idLoaded);

    // Render contacts + groups
    await UI.renderContacts();
    await UI.renderGroups();

    // Listen on all saved groups
    const groups = await Storage.getGroups();
    groups.forEach(g => {
      Network.listenGroup(g.groupId, blob => App.receiveGroupMsg(blob, g));
    });

    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Audio.click();
        UI.switchTab(btn.dataset.tab);
        if (btn.dataset.tab === 'items') UI.renderContacts();
        if (btn.dataset.tab === 'radio') UI.renderGroups();
      });
    });

    // Send
    document.getElementById('send-btn').addEventListener('click', () => { Audio.click(); App.sendMessage(); });
    document.getElementById('msg-input').addEventListener('keydown', e => { if (e.key === 'Enter') App.sendMessage(); });

    // Share link auto-detect
    const hash = location.hash;
    if (hash && hash.includes('id=')) {
      const m = hash.match(/id=([^&]+)/);
      if (m) {
        document.getElementById('contact-input').value = decodeURIComponent(m[1]);
        UI.switchTab('items');
        document.getElementById('add-contact-form').style.display = 'block';
        UI.notify('> INCOMING CONTACT REQUEST DETECTED — REVIEW AND CONFIRM');
      }
    }

  } catch(err) {
    console.error('PipChat init error:', err);
    document.getElementById('boot-overlay').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    UI.notify('> CRITICAL INIT ERROR: ' + err.message, 'err');
  }
}

init();
