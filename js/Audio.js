'use strict';

class AudioManager {
  #ctx = null;

  #ensure() {
    if (!this.#ctx) this.#ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.#ctx;
  }

  beep(freq = 880, dur = 0.04, vol = 0.08) {
    try {
      const c = this.#ensure();
      const o = c.createOscillator();
      const g = c.createGain();
      o.connect(g); g.connect(c.destination);
      o.frequency.value = freq; o.type = 'square';
      g.gain.setValueAtTime(vol, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
      o.start(); o.stop(c.currentTime + dur);
    } catch(_) {}
  }

  click() { this.beep(1200, 0.03, 0.06); }
  send()  { this.beep(880, 0.05, 0.08); this.beep(1100, 0.04, 0.06); }
  recv()  { this.beep(660, 0.04, 0.05); this.beep(880, 0.06, 0.07); }
  error() { this.beep(220, 0.15, 0.1); }
}

const Audio = new AudioManager();
