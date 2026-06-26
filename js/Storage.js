'use strict';

class StorageManager {
  #db = null;
  #DB_NAME = 'pipchat_v1';
  #DB_VER = 1;

  #open() {
    if (this.#db) return Promise.resolve(this.#db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(this.#DB_NAME, this.#DB_VER);
      r.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('identity')) d.createObjectStore('identity', {keyPath:'id'});
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', {keyPath:'key'});
        if (!d.objectStoreNames.contains('contacts')) d.createObjectStore('contacts', {keyPath:'userId'});
        if (!d.objectStoreNames.contains('groups'))   d.createObjectStore('groups',   {keyPath:'groupId'});
        if (!d.objectStoreNames.contains('pending'))  d.createObjectStore('pending',  {keyPath:'id', autoIncrement:true});
        if (!d.objectStoreNames.contains('messages')) {
          const ms = d.createObjectStore('messages', {keyPath:'id'});
          ms.createIndex('conv', 'conv', {unique:false});
        }
      };
      r.onsuccess = e => { this.#db = e.target.result; res(this.#db); };
      r.onerror   = e => rej(e.target.error);
    });
  }

  #idb(store, mode, fn) {
    return this.#open().then(d => new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const req = fn(s);
      if (req && typeof req.onsuccess !== 'undefined') {
        req.onerror = () => rej(req.error);
        if (mode === 'readwrite') {
          // resolve after transaction commits so writes are truly durable
          t.oncomplete = () => res(req.result);
          t.onerror    = () => rej(t.error);
        } else {
          req.onsuccess = () => res(req.result);
        }
      } else {
        t.oncomplete = () => res();
        t.onerror    = () => rej(t.error);
      }
    }));
  }

  saveIdentity(kp)   { return this.#idb('identity', 'readwrite', s => s.put({id:'main', ...kp})); }
  loadIdentity()     { return this.#idb('identity', 'readonly',  s => s.get('main')); }
  saveSetting(k, v)  { return this.#idb('settings', 'readwrite', s => s.put({key:k, value:v})); }
  getSetting(k)      { return this.#idb('settings', 'readonly',  s => s.get(k)).then(r => r ? r.value : null); }
  saveContact(c)     { return this.#idb('contacts', 'readwrite', s => s.put(c)); }
  getContacts()      { return this.#idb('contacts', 'readonly',  s => s.getAll()); }
  delContact(uid)    { return this.#idb('contacts', 'readwrite', s => s.delete(uid)); }
  saveGroup(g)       { return this.#idb('groups',   'readwrite', s => s.put(g)); }
  getGroups()        { return this.#idb('groups',   'readonly',  s => s.getAll()); }
  delGroup(gid)      { return this.#idb('groups',   'readwrite', s => s.delete(gid)); }
  addPending(m)      { return this.#idb('pending',  'readwrite', s => s.add(m)); }
  getPending()       { return this.#idb('pending',  'readonly',  s => s.getAll()); }
  delPending(id)     { return this.#idb('pending',  'readwrite', s => s.delete(id)); }
  clearPending()     { return this.#idb('pending',  'readwrite', s => s.clear()); }
  saveMessage(m)     { return this.#idb('messages', 'readwrite', s => s.put(m)); }

  getMessages(conv, lim = 200) {
    return this.#open().then(d => new Promise((res, rej) => {
      const t   = d.transaction('messages', 'readonly');
      const idx = t.objectStore('messages').index('conv');
      const req = idx.getAll(conv);
      req.onsuccess = () => res((req.result||[]).sort((a,b) => a.ts - b.ts).slice(-lim));
      req.onerror   = () => rej(req.error);
    }));
  }

  async nuke() {
    const d = await this.#open();
    for (const n of ['identity','settings','contacts','groups','pending','messages']) {
      await new Promise(res => {
        const t = d.transaction(n, 'readwrite');
        t.objectStore(n).clear();
        t.oncomplete = res;
      });
    }
  }
}

const Storage = new StorageManager();
