# PipChat

**[https://huecraft143.github.io/pipchat/](https://huecraft143.github.io/pipchat/)**

Anonymous, serverless, end-to-end encrypted chat with a Pip-Boy / Fallout aesthetic.  
No accounts. No servers that see your messages. No logs. Your identity lives only in your browser.

> **Status:** Direct messages are fully functional. Group channels are **not working** — the WebRTC-based group transport is partially implemented and unreliable. Do not rely on group chat for anything.

---

## Features

- **Zero registration** — identity is a cryptographic keypair generated locally on first load
- **End-to-end encrypted DMs** — X3DH key agreement + KDF ratchet chain (Signal-style forward secrecy)
- **Signed prekey rotation** — weekly key rotation, X3DH-like handshake for new sessions
- **Encrypted group channels** — symmetric XSalsa20-Poly1305, invite-code based ⚠️ *not working*
- **Direct P2P mode** — optional WebRTC DataChannel that bypasses the relay entirely
- **ICE candidate filtering** — real LAN IPs never leave the browser; only mDNS and srflx candidates are sent
- **Sender identity inside ciphertext** — in ratchet mode, the relay never sees who is talking to whom beyond UIDs
- **Self-destructing relay messages** — DM blobs are deleted from the relay after delivery
- **Offline message queueing** — group messages pending delivery are saved to IndexedDB and flushed when the peer reconnects

---

## Architecture

### Identity

On first load, libsodium generates an **Ed25519 keypair** locally. The private key never leaves the browser. The public key is converted to **Curve25519** for DH operations using libsodium's `crypto_sign_ed25519_pk_to_curve25519`. Your UID is the first 8 characters of a BLAKE2b hash of the Ed25519 public key (e.g. `@a3f9bc12`).

A **Signed Prekey (SPK)** — a separate Curve25519 keypair — is generated on first launch and rotated weekly. It is signed with your Ed25519 identity key and published to the Gun relay at `pipchat_spk_<uid>`. The SPK is what enables X3DH without both parties being online simultaneously.

Everything is stored in **IndexedDB**. Clearing browser site data permanently destroys your identity unless you exported a backup.

---

### Encryption — Direct Messages

PipChat uses a two-tier DM encryption scheme.

#### Primary: X3DH + KDF ratchet chain

When sending a first message to a contact, PipChat performs an **X3DH (Extended Triple Diffie-Hellman)** key agreement:

```
Alice knows: her IK_A (identity keypair), a fresh EK_A (ephemeral keypair)
Bob published: his IK_B (identity keypair), SPK_B (signed prekey)

dh1 = DH(IK_A,  SPK_B)   — Alice's identity × Bob's signed prekey
dh2 = DH(EK_A,  IK_B)    — Alice's ephemeral × Bob's identity
dh3 = DH(EK_A,  SPK_B)   — Alice's ephemeral × Bob's signed prekey

shared_secret = BLAKE2b(dh1 ‖ dh2 ‖ dh3)
```

From `shared_secret`, two independent 32-byte chain keys are derived via BLAKE2b keyed hash (`pipchat-chain-1`, `pipchat-chain-2`). Alice takes `ck1` as her send chain, Bob takes `ck2` as his send chain.

**Per-message key derivation (KDF ratchet)**:

Each send/receive operation advances the chain:

```
newChainKey = BLAKE2b("advance", chainKey)
msgKey      = BLAKE2b("msgkey",  chainKey)
```

The message is encrypted with `crypto_secretbox_easy(plaintext, nonce, msgKey)` (XSalsa20-Poly1305). After encryption, `msgKey` is discarded — it cannot be recovered from `newChainKey`. Out-of-order messages are handled by caching up to 100 skipped message keys per conversation.

**What goes in the ciphertext**: the inner plaintext contains `{ text, senderSignPub, senderBoxPub, sig }`. The Ed25519 signature covers the identity fields so the recipient can verify the sender. The relay only ever sees an opaque blob — it has no access to sender public keys, signature, or plaintext.

The X3DH handshake parameters (`ekPub`, `senderBoxPub`, `msgNum`) are serialized as a JSON string in the blob's `ratchet` field (a workaround for Gun.js graph serialization — nested objects become `{ '#': 'hash' }` references on retrieval).

#### Fallback: ephemeral X25519 + NaCl box

If the recipient has no SPK published, PipChat falls back to `crypto_box_easy` (X25519 + XSalsa20-Poly1305) using a per-session ephemeral keypair. In this mode, sender public keys are visible in the blob metadata. The fallback is used only on first contact when the other party has never loaded the app.

---

### Encryption — Group Channels

Groups use **symmetric encryption**: `crypto_secretbox_easy` with a 256-bit random key generated at group creation. The key is embedded in the invite code (`groupId|key|name`) which must be shared out-of-band.

Every group message carries an **Ed25519 signature** over `{ ct, nonce, from, groupId, ts }`. Messages with invalid or missing signatures are displayed with a corruption warning but not silently dropped.

---

### Transport Layer

PipChat uses two transport layers in parallel.

#### 1. Gun.js relay (always active)

[Gun.js](https://gun.eco/) is a CRDT-based real-time graph database. PipChat uses a self-hosted Gun relay as a message broker and peer discovery point.

Gun namespace layout:

| Key pattern | Purpose |
|---|---|
| `pipchat_dm_<uid>` | DM blobs (deleted after delivery) |
| `pipchat_signal_<uid>` | WebRTC signaling (60-second TTL) |
| `pipchat_profiles` | Public profiles (nick, public keys) |
| `pipchat_spk_<uid>` | Signed prekeys |
| `pipchat_ephem_<uid>` | Session ephemeral Curve25519 pubkeys |
| `pipchat_grp_presence_<gid>` | Group peer discovery |

DM blobs are deleted from the relay ~2 seconds after delivery via `gun.get(...).put(null)` (best-effort). Blobs older than 7 days are discarded on receipt via an `expires` field.

Gun's gossip protocol propagates all nodes to every connected relay. Since all content is encrypted, gossiped blobs reveal no plaintext, but they do increase the surface for traffic analysis.

#### 2. WebRTC DataChannel (optional, user-initiated)

For DMs, either party can request a direct P2P connection. Signaling (offer/answer/ICE) flows through the Gun relay channel with a 60-second TTL. Once the DataChannel is open, messages bypass the relay entirely.

ICE candidate filtering is applied before signaling:

```js
// Host candidates with real LAN IPs are filtered out.
// mDNS (.local) candidates are UUID-based — safe to share.
if (candidate.type === 'host' && !candidate.address?.endsWith('.local')) {
  return; // filtered — LAN IP not sent
}
```

Only `srflx` (server-reflexive, public IP via STUN) and `.local` mDNS candidates are forwarded to the peer.

For group channels, WebRTC connections are established automatically when multiple members are online, using a deterministic tie-breaking rule (`uid_A < uid_B` → A initiates the offer) to avoid offer collisions.

**Stale signal replay prevention**: processed WebRTC signal keys are persisted to localStorage with a 2-minute TTL. On page reload, `#seen` is pre-populated from localStorage, so Gun's signal replay doesn't trigger spurious invite dialogs.

---

### Data Flow — Sending a DM

```
User types a message
        │
        ▼
App.sendMessage()
        │
        ├─ hasSession(uid)?
        │       ├─ YES → Ratchet.encrypt() → blob with { ratchet: '{"type":"ratchet","msgNum":N}' }
        │       └─ NO  ─┬─ fetchSpk(uid) → verify SPK signature
        │               ├─ X3DH(IK_A, EK_A, IK_B, SPK_B) → shared_secret
        │               ├─ Ratchet.initSession() → KDF chain initialized
        │               └─ Ratchet.encrypt() → blob with { ratchet: '{"type":"x3dh","ekPub":...}' }
        │
        ▼
Network.sendDM(uid, blob)
        │
        ├─ dmMode === 'direct' → dc.send(blob)  ← WebRTC DataChannel
        └─ dmMode === 'relay'  → gun.get('pipchat_dm_<uid>').set(blob)  ← Gun relay
```

---

### Data Flow — Receiving a DM

```
Gun relay or WebRTC DataChannel delivers blob
        │
        ▼
App.dmCallback(blob)
        │
        ├─ blob.ratchet (string) present?
        │       ├─ YES: handleDMRatchet()
        │       │       ├─ r.type === 'x3dh'? → derive shared_secret, initSession(responder)
        │       │       ├─ Ratchet.decrypt(uid, ct, nonce, msgNum)
        │       │       ├─ verify inner.sig with inner.senderSignPub
        │       │       └─ auto-save contact if not in contacts
        │       └─ NO: handleDMLegacy()
        │               ├─ verify blob.sig with blob.senderSignPub
        │               └─ crypto_box_open_easy(ct, nonce, senderBoxPub, myBoxSec)
        │
        ▼
deliverDM(senderUid, plaintext, blobId, blobTs)
        ├─ saveMessage() to IndexedDB
        └─ renderMessages() or UI.notify() if chat not open
```

---

## Privacy Model

### What the relay sees

| Data | Visible to relay |
|---|---|
| Message content | No (E2E encrypted) |
| Sender identity (ratchet mode) | No (inside ciphertext) |
| Sender identity (legacy mode) | Yes (in blob metadata) |
| Communication graph (uid_A → uid_B) | Yes |
| Your public IP (WebSocket connection) | Yes |
| Your real LAN IP | No (filtered by ICE) |
| Blob timestamps | Yes |
| Public profiles (nick, pubkeys) | Yes (intentionally) |

### What the WebRTC peer sees

In direct mode, your counterpart sees your **public IP** via the srflx ICE candidate. Your real LAN IP is filtered. The message content is delivered over the same encrypted ratchet channel — the WebRTC transport is an alternative delivery path, not a separate encryption layer.

### What the STUN server sees

STUN is used only to discover your public IP for ICE negotiation. The STUN server sees your public IP — the same IP the Gun relay WebSocket already sees.

### Remaining structural limitations

- **Communication graph**: the relay knows that uid_A sends messages to uid_B, with timestamps. This cannot be hidden while using Gun's addressed message store.
- **Public IP exposure**: both the Gun relay (WebSocket) and any WebRTC peer (srflx) see your public IP. Mitigations: Tor Browser (routes both through Tor exit nodes), VPN, or a TURN relay for WebRTC.
- **Gun gossip**: blobs are propagated to all Gun nodes connected to the relay network, not only the intended relay. Content is encrypted; the risk is additional traffic analysis surface.
- **STUN provider**: Google STUN servers are used for reliability. Self-hosting [coturn](https://github.com/coturn/coturn) eliminates this dependency entirely.

### What has no server-side equivalent

- No phone number, email, or account required
- No server-side message storage (blobs are deleted after delivery)
- No server-side key storage (all keypairs are browser-local)
- No server-side logs of message content or sender identity

---

## Known Vulnerabilities and Open Problems

### Network / metadata

**Communication graph visible to relay**  
The relay knows that uid_A is writing to uid_B, with timestamps. Gun's addressed store (`pipchat_dm_<uid>`) makes routing metadata unavoidable at the relay level.  
_Possible solutions_: anonymous broadcast (everyone downloads everything, decrypts only their own — high bandwidth cost); mix networks (Nym, Loopix) with artificial delays to break timing correlation; replacing Gun with a transport that supports sealed sender. None of these are free or trivial.

**Public IP exposed to relay and STUN server**  
Every WebSocket connection to the Gun relay reveals your public IP. Every WebRTC negotiation reveals it again to the STUN server and to the peer via the srflx candidate.  
_Possible solutions_: Tor Browser routes both the Gun WebSocket and the STUN request through Tor exit nodes at zero cost. A VPN moves trust from the relay operator to the VPN provider. A self-hosted TURN server proxies WebRTC traffic so the peer sees the TURN IP instead of yours, but the TURN server itself still sees you.

**Gun gossip propagates ciphertext to all connected nodes**  
Gun's gossip protocol replicates every node to every peer connected to the same relay network. Encrypted blobs spread further than intended, increasing the number of parties that can perform traffic analysis.  
_Possible solutions_: a private Gun network (connect only trusted peers, not the public Gun network); replacing Gun with a point-to-point WebSocket transport; accepting the risk since content is encrypted and the main concern is metadata surface.

---

### Cryptographic protocol

**No DH ratchet (no break-in recovery)**  
PipChat implements a symmetric KDF ratchet (forward secrecy: past message keys are deleted and cannot be rederived). It does not implement the Diffie-Hellman ratchet component of the Signal Double Ratchet. This means: if an attacker compromises the chain key at message N, they can derive all future message keys until the next X3DH session. Signal's DH ratchet resets the chain key on every reply, giving post-compromise security. Implementing this requires each message to carry a new ephemeral DH public key and the chain to reset on each ratchet step.

**No one-time prekeys (OPKs)**  
Signal's X3DH uses a bundle of one-time prekeys (OPKs) in addition to the SPK, so each new session consumes a fresh OPK. Without OPKs, if an attacker records all traffic and later compromises the SPK private key, they can reconstruct the X3DH shared secret for every session that used that SPK during its active period (up to one week). Adding OPKs would require a prekey replenishment mechanism over the relay.

**Legacy fallback leaks sender identity**  
When a peer has not yet published an SPK (e.g. first ever load), PipChat falls back to a scheme where `senderSignPub` and `senderBoxPub` appear in cleartext in the blob metadata. The relay can see them. The fallback disappears after both parties have loaded the app at least once and published their SPK.  
_Possible solution_: refuse to send until the peer's SPK is available, with a user-visible "waiting for peer key" state.

**Group channels have no forward secrecy**  
Group encryption uses a single static symmetric key for the lifetime of the group. Anyone who ever had the invite code can decrypt all past and future messages. There is no key rotation, no member removal, no post-compromise security.  
_Possible solution_: Sender Keys (Signal's group protocol) — each member generates their own ratchet chain and distributes their chain key to other members. Key rotation on member removal. Significant complexity.

**No key verification UI**  
There is no fingerprint comparison or safety number screen. A compromised or malicious relay could substitute a different public key for a contact's profile, enabling a MITM attack on the first contact exchange. Once the X3DH session is established from the correct key the channel is secure, but the initial key fetch is unauthenticated.  
_Possible solution_: display a short fingerprint (e.g. 6 words from the signPub hash) that users can compare out-of-band before trusting a new contact.

**SPK signature not checked against a pinned identity**  
When fetching a peer's SPK, the app verifies the SPK signature against the peer's `signPub`. However, `signPub` itself is fetched from the Gun relay's profile store and is not pinned on first use (TOFU). A relay operator could swap both the profile and the SPK simultaneously.  
_Possible solution_: pin the `signPub` on first add-contact and refuse any future profile update that changes it.

---

## Stack

| Layer | Technology |
|---|---|
| Cryptography | [libsodium-wrappers](https://github.com/jedisct1/libsodium.js) 0.7.13 |
| Key agreement | X3DH (Extended Triple Diffie-Hellman) |
| Message encryption | KDF ratchet chain → XSalsa20-Poly1305 |
| Signatures | Ed25519 |
| P2P sync / relay | [Gun.js](https://gun.eco/) |
| Direct transport | WebRTC DataChannel |
| Storage | IndexedDB (browser-native) |
| Relay server | Node.js + Gun (12 lines) |
| Frontend | Vanilla JS (ES6 classes, no bundler, no framework) |

---

## Project Structure

```
pipchat/
├── index.html        HTML + CSS (Pip-Boy / Fallout theme)
├── relay.js          Gun.js relay server (Node.js)
├── package.json
└── js/
    ├── utils.js      Constants, esc(), delay(), showModal()
    ├── Audio.js      Web Audio API beeps and clicks
    ├── Storage.js    IndexedDB wrapper (messages, contacts, groups, ratchet, SPK)
    ├── Crypto.js     libsodium operations (keypairs, DH, X3DH, ratchet KDF, box, sign)
    ├── Ratchet.js    KDF ratchet state machine (encrypt/decrypt/skip-key cache)
    ├── Identity.js   Keypair lifecycle (generate, store, export, import, destroy)
    ├── Network.js    Gun.js P2P layer + WebRTC signaling + ICE filtering
    ├── UI.js         DOM rendering (contacts, messages, groups, status)
    ├── App.js        Application logic (send, receive, DM/group routing)
    └── main.js       Boot sequence, event wiring, SPK rotation
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

**Settings → Pages → Deploy from branch → main → / (root) → Save**

Your app will be live at `https://YOUR_USERNAME.github.io/pipchat`.

### 3. Deploy the relay — Render.com (free tier)

1. Go to [render.com](https://render.com) and sign in with GitHub
2. **New → Web Service** → connect the `pipchat` repo
3. Configure:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node relay.js`
   - **Instance Type:** Free
4. Click **Create Web Service** → wait for the first deploy
5. Copy the service URL, e.g. `https://pipchat-xyz.onrender.com`

> Render's free tier spins down after 15 minutes of inactivity. The first connection after idle takes ~30 seconds. Once the relay is warm, it works normally.

### 4. Set the relay URL

Edit `js/Network.js`:

```js
#RELAYS = [
  'https://pipchat-xyz.onrender.com/gun',
];
```

Push, and GitHub Pages updates automatically.

---

## Identity Backup

Your identity keypair is stored only in your browser's IndexedDB.

- Use **[EXPORT BACKUP]** in the settings panel to download a backup file
- Use **[IMPORT IDENTITY]** to restore it in another browser or after clearing site data
- **[!! DESTROY IDENTITY !!]** wipes all local data permanently

---

## Running Locally

```bash
npm install
node relay.js   # starts the Gun relay on port 8765
```

Then open `index.html` via any local HTTP server:

```bash
npx serve .          # serves on http://localhost:3000
# or
python -m http.server
```

> The app cannot be opened directly from `file://` — CDN scripts (libsodium, Gun) are blocked by browsers on file origins.
