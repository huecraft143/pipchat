# PipChat

Anonymous P2P end-to-end encrypted chat, Pip-Boy / Fallout theme.  
No accounts, no servers, no logs. Your identity lives only in your browser.

---

## How it works

### Identity

When you open the app for the first time, a cryptographic keypair is generated locally and saved in your browser's IndexedDB. Nothing is sent to any server. Your identity is a short 8-character ID derived from a BLAKE2b hash of your public key (e.g. `@a3f9bc12`).

If you clear your browser data, your identity is gone. Use **[EXPORT BACKUP]** in the settings panel to save it.

### Encryption

- **Direct messages** — asymmetric encryption (X25519 Diffie-Hellman + XSalsa20-Poly1305). Only the intended recipient can decrypt.
- **Group channels** — symmetric encryption (XSalsa20-Poly1305) with a shared key distributed via invite code.
- Every message is signed with Ed25519. Messages with missing or invalid signatures are rejected.

Cryptography is provided by [libsodium](https://libsodium.gitbook.io/doc/).

### P2P sync

Messages are synced peer-to-peer using [Gun.js](https://gun.eco/), a CRDT-based real-time graph database. Gun uses a relay server only as a bootstrapping point — once peers discover each other, data flows directly between browsers.

> **Note:** Public Gun.js relays (including gun.eco) do not work reliably — they accept the HTTP connection but fail the WebSocket upgrade, so Gun falls back to broken HTTP polling. You must deploy your own relay (see below).

### Contacts

To message someone, you need their public key or share link. Add it via **[+ ADD DWELLER]** in the ITEMS tab. The recipient does not need to add you first — when your first message arrives, they are auto-saved in their contacts list.

### Groups

Create a channel in the RADIO tab, copy the invite code, share it out-of-band (Signal, email, etc.). Anyone with the invite code can join. The invite code contains the group ID and the symmetric encryption key — treat it like a password.

---

## Stack

| Layer | Technology |
|---|---|
| Crypto | libsodium-wrappers 0.7.13 |
| P2P sync | Gun.js |
| Storage | IndexedDB (browser-native) |
| Relay | Node.js + Gun (self-hosted) |
| Frontend | Vanilla JS (ES6 classes), no bundler |

---

## Project structure

```
pipchat/
├── index.html        HTML + CSS (Pip-Boy theme)
├── relay.js          Gun.js relay server (Node.js)
├── package.json
└── js/
    ├── utils.js      Constants, esc(), delay(), showModal()
    ├── Audio.js      Web Audio beeps
    ├── Storage.js    IndexedDB wrapper
    ├── Crypto.js     libsodium operations
    ├── Identity.js   Keypair lifecycle
    ├── Network.js    Gun.js P2P layer
    ├── UI.js         DOM rendering
    ├── App.js        Application logic
    └── main.js       Startup and event wiring
```

---

## Deploy

The app requires two separate deployments: the static frontend and the Gun.js relay.

### 1. Create a GitHub repo and push

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/pipchat.git
git push -u origin main
```

### 2. Deploy the frontend — GitHub Pages

In your repo: **Settings → Pages → Deploy from branch → main → / (root) → Save**

Your app will be live at `https://YOUR_USERNAME.github.io/pipchat`.

### 3. Deploy the relay — Render.com (free)

1. Go to [render.com](https://render.com) and sign in with GitHub
2. **New → Web Service** → connect the `pipchat` repo
3. Set these fields:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node relay.js`
   - **Instance Type:** Free
4. Click **Create Web Service** → wait for the first deploy
5. Copy the URL shown at the top, e.g. `https://pipchat-relay.onrender.com`

> **Note:** Render's free tier spins down the service after 15 minutes of inactivity. The first connection after a period of silence takes ~30 seconds to wake up. Once the relay is warm, everything works normally.

### 4. Set the relay URL

Edit `js/Network.js` and replace the `#RELAYS` array with your Render URL:

```js
#RELAYS = [
  'https://pipchat-relay.onrender.com/gun',
];
```

Then push:

```bash
git add js/Network.js
git commit -m "set relay url"
git push
```

GitHub Pages updates automatically. The app is live.

---

## Privacy model

- No registration, no email, no phone number
- Identity keypair never leaves your device in plaintext
- The relay only sees encrypted Gun.js graph nodes — it has no knowledge of users or message content
- The relay does not store messages permanently — Gun.js uses it only for initial peer discovery and message relay until peers sync directly
- Clearing browser site data destroys your identity permanently (unless you exported a backup)
