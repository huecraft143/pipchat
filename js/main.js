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
    window.saveNick = async () => {
      const input = document.getElementById('nick-input');
      const v = input.value.trim();
      await Storage.saveSetting('nick', v);
      UI.setNick(v);
      await Network.publishProfile({ uid:Identity.uid(), nick:v, signPub:Identity.signPub(), boxPub:Identity.boxPub() });
      UI.notify('> DESIGNATION UPDATED');
    };
    const nickInput = document.getElementById('nick-input');
    nickInput.addEventListener('change', window.saveNick);
    nickInput.addEventListener('keydown', e => { if (e.key === 'Enter') window.saveNick(); });

    // Network
    await Network.init();
    Network.setDmCallback(App.dmCallback);
    Network.setDmModeCallback(App.dmModeChangedCallback);
    Network.setDmRequestCallback(App.dmRequestCallback);
    Network.startListening();
    await Network.publishProfile({ uid:Identity.uid(), nick:nick||null, signPub:Identity.signPub(), boxPub:Identity.boxPub() });

    // Signed prekey — generate or rotate (weekly)
    await (async () => {
      const SPK_TTL = 7 * 24 * 60 * 60 * 1000;
      let spk = await Storage.getMySpk();
      if (!spk || Date.now() - spk.ts > SPK_TTL) {
        const kp    = Identity.kp();
        const spkKp = Crypto.generateBoxKeypair();
        const sig   = Crypto.sign(spkKp.boxPub, kp.signSec);
        spk = { pub: spkKp.boxPub, sec: spkKp.boxSec, sig, ts: Date.now() };
        await Storage.saveMySpk(spk);
        console.log('[SPK][GENERATED] new signed prekey');
      } else {
        console.log('[SPK][LOADED] age:', Math.round((Date.now() - spk.ts) / 86400000), 'days');
      }
      Network.publishSpk(spk);
    })();

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

    // Notify peers and clean up WebRTC direct connections when tab closes
    window.addEventListener('pagehide', () => Network.closeAllDirect());

  } catch(err) {
    console.error('PipChat init error:', err);
    document.getElementById('boot-overlay').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    UI.notify('> CRITICAL INIT ERROR: ' + err.message, 'err');
  }
}

init();
