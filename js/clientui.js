// The playful layer of the client page: the title, magnetic start button, trailing cursor,
// sliding camera marker and sound meter. Black and white only; everything switches off for reduced motion.
const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FINE = matchMedia('(hover: hover) and (pointer: fine)').matches;
const $ = id => document.getElementById(id);

export function rollLabel(text) {
  return `<span class="roll"><span>${text}</span><span aria-hidden="true">${text}</span></span>`;
}

export class ClientUI {
  constructor() {
    this.title = $('startTitle');
    this.start = $('start');
    this.btn = $('startBtn');
    this.cur = $('cur');
    this.hasTitle = false;
    this.px = -1e4; this.py = -1e4; this.pointerOn = false;
    this.cx = innerWidth / 2; this.cy = innerHeight / 2;
    this.bars = [...document.querySelectorAll('#tMute .eq b')];
    this.transport = $('transport');
    addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      this.px = e.clientX; this.py = e.clientY; this.pointerOn = true;
    }, { passive: true });
    document.addEventListener('pointerleave', () => { this.pointerOn = false; this.px = this.py = -1e4; });
    addEventListener('resize', () => { this.fit(); this.moveCamDot(); });
    if (FINE && !CALM) {
      this.cur.classList.add('on');
      addEventListener('pointerover', e => {
        this.cur.classList.toggle('big', !!e.target.closest?.('button:not(:disabled), a, #tBar'));
      }, { passive: true });
    }
    // the hover fill grows from where the pointer came in
    this.btn.addEventListener('pointerenter', e => {
      const r = this.btn.getBoundingClientRect();
      this.btn.style.setProperty('--fx', `${e.clientX - r.left}px`);
      this.btn.style.setProperty('--fy', `${e.clientY - r.top}px`);
    });
    requestAnimationFrame(() => this.loop());
  }

  setLabel(text) {
    this.btn.querySelector('.roll').outerHTML = rollLabel(text);
  }

  // Every letter gets its own mask, so it can rise into place and react on its own.
  setTitle(text) {
    const words = text.trim().toUpperCase().split(/\s+/);
    this.title.setAttribute('aria-label', text);
    this.title.replaceChildren();
    this.hasTitle = true;
    let n = 0;
    words.forEach((word, w) => {
      const wEl = document.createElement('span');
      wEl.className = 'w' + (w === words.length - 1 ? '' : ' gray');
      wEl.setAttribute('aria-hidden', 'true');
      for (const ch of word) {
        const c = document.createElement('span'), m = document.createElement('span'), g = document.createElement('span');
        c.className = 'c'; m.className = 'm'; g.className = 'g';
        m.style.setProperty('--i', n);
        g.textContent = ch;
        m.append(g); c.append(m); wEl.append(c);
        n++;
      }
      this.title.append(wEl, ' ');
    });
    this.fit();
    document.fonts.ready.then(() => this.fit());
  }

  // Long titles shrink so the widest word still fits the screen.
  fit() {
    if (!this.hasTitle) return;
    this.title.style.fontSize = '';
    const room = this.title.parentElement.clientWidth;
    let widest = 0;
    this.title.querySelectorAll('.w').forEach(w => { widest = Math.max(widest, w.offsetWidth); });
    const need = widest * 1.02;
    if (need > room) {
      const size = parseFloat(getComputedStyle(this.title).fontSize);
      this.title.style.fontSize = `${Math.floor(size * room / need)}px`;
    }
  }

  enter() {
    this.start.classList.remove('gone', 'leaving', 'in');
    void this.start.offsetWidth;                         // restart the entrance
    this.start.classList.add('in');
  }

  exit() {
    this.start.classList.add('leaving');
    this.cur.classList.remove('big');
    if (!CALM) {
      const r = this.btn.getBoundingClientRect(), b = $('burst');
      b.style.setProperty('--bx', `${r.left + r.width / 2}px`);
      b.style.setProperty('--by', `${r.top + r.height / 2}px`);
      b.classList.remove('go');
      void b.offsetWidth;
      b.classList.add('go');
    }
    setTimeout(() => { this.start.classList.add('gone'); this.moveCamDot(); }, CALM ? 0 : 420);
    requestAnimationFrame(() => this.moveCamDot());
  }

  moveCamDot() {
    const on = document.querySelector('#cams button.on'), dot = $('camDot');
    if (!on || !on.offsetWidth) return;
    dot.style.transform = `translateX(${on.offsetLeft + on.offsetWidth / 2 - 2}px)`;
    dot.style.opacity = 1;
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    this.cx += (this.px - this.cx) * 0.2;
    this.cy += (this.py - this.cy) * 0.2;
    if (FINE && !CALM) this.cur.style.transform = `translate(${this.cx}px, ${this.cy}px)`;
    if (CALM || document.body.classList.contains('started')) return;
    this.magnet();
  }

  magnet() {
    if (this.btn.disabled || !this.pointerOn) { this.btn.style.translate = ''; return; }
    const r = this.btn.getBoundingClientRect();
    const baseX = r.left + r.width / 2 - (this.mx || 0), baseY = r.top + r.height / 2 - (this.my || 0);
    const dx = this.px - baseX, dy = this.py - baseY, d = Math.hypot(dx, dy), pull = d < 180 ? 1 - d / 180 : 0;
    this.mx = (this.mx || 0) + (dx * 0.3 * pull - (this.mx || 0)) * 0.18;
    this.my = (this.my || 0) + (dy * 0.42 * pull - (this.my || 0)) * 0.18;
    this.btn.style.translate = `${this.mx.toFixed(1)}px ${this.my.toFixed(1)}px`;
  }

  // Player details driven by the show itself.
  update({ hit, audio, muted, playing }) {
    if (!document.body.classList.contains('started') || CALM) return;
    this.transport.style.setProperty('--hit', hit.toFixed(2));
    const buf = audio.analyser ? audio.buf : null;
    this.bars.forEach((b, k) => {
      const v = buf && !muted && playing ? buf[[3, 10, 28, 70][k]] / 255 : 0;
      b.style.transform = `scaleY(${(0.16 + 0.84 * v * v).toFixed(2)})`;
    });
  }
}
