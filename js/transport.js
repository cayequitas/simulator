// Play / pause, scrub bar with timeline markers and sound button for the video on the LED wall.
export class Transport {
  constructor(video, opts) {
    this.video = video;
    this.opts = opts;
    this.el = document.getElementById('transport');
    this.play = document.getElementById('tPlay');
    this.mute = document.getElementById('tMute');
    this.time = document.getElementById('tTime');
    this.bar = document.getElementById('tBar');
    this.fill = document.getElementById('tFill');
    this.marks = document.getElementById('tMarks');
    this.markKey = '';
    this.play.onclick = () => this.toggle();
    this.mute.onclick = () => { opts.setMuted(!opts.isMuted()); this.update(true); };
    const seek = e => {
      const r = this.bar.getBoundingClientRect();
      const u = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      if (Number.isFinite(video.duration)) { video.currentTime = u * video.duration; opts.onSeek(); }
    };
    this.bar.onpointerdown = e => { this.bar.setPointerCapture(e.pointerId); this.dragging = true; seek(e); };
    this.bar.onpointermove = e => { if (this.dragging) seek(e); };
    this.bar.onpointerup = () => { this.dragging = false; };
  }

  available() { return Number.isFinite(this.video.duration) && this.video.duration > 0 && !this.video.srcObject; }

  toggle() {
    const v = this.video;
    this.opts.onUserGesture();
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }

  static fmt(t) {
    if (!Number.isFinite(t)) return '0:00';
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  update(active) {
    const on = !!active && this.available();
    this.el.classList.toggle('on', on);
    if (!on) return;
    const v = this.video;
    this.fill.style.width = `${(v.currentTime / v.duration) * 100}%`;
    this.time.textContent = `${Transport.fmt(v.currentTime)} / ${Transport.fmt(v.duration)}`;
    this.play.dataset.state = v.paused ? 'paused' : 'playing';
    this.mute.querySelector('.lbl').textContent = this.opts.isMuted() ? 'Sound off' : 'Sound on';
    const list = this.opts.markers();
    const key = list.map(m => m.t + m.look).join('|') + v.duration;
    if (key !== this.markKey) {
      this.markKey = key;
      this.marks.replaceChildren(...list.map(m => {
        const d = document.createElement('i');
        d.style.left = `${(m.t / v.duration) * 100}%`;
        d.title = `${m.look} · ${Transport.fmt(m.t)}`;
        return d;
      }));
    }
  }
}
