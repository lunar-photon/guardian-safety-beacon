// Animated backdrop for the city pages: rain, snow, stars, lightning, drifting cloud and fog.
// Runs at ~30 fps on one canvas, and only while it is visible and motion is enabled.

const rand = (a, b) => a + Math.random() * (b - a);

export class Sky {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.theme = 'clear-day';
    this.intensity = 0.5;
    this.running = false;
    this.last = 0;
    this.flash = 0;
    this.parts = [];
    this.clouds = [];
    this.stars = [];
    this.shoot = null;
    this.resize = this.resize.bind(this);
    this.frame = this.frame.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.c.width = Math.round(this.w * dpr); this.c.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.seed();
  }

  set(theme, intensity = 0.5) {
    if (theme === this.theme && Math.abs(intensity - this.intensity) < 0.05) return;
    this.theme = theme; this.intensity = intensity;
    this.seed();
    if (!this.running) this.draw(0);
  }

  seed() {
    const [kind, time] = this.theme.split('-');
    this.kind = kind; this.night = time === 'night';
    const area = (this.w * this.h) / (390 * 844);
    const n = (base) => Math.round(base * area * (0.4 + this.intensity));
    this.parts = [];
    if (kind === 'rain' || kind === 'storm') {
      for (let i = 0; i < n(kind === 'storm' ? 120 : 90); i++) this.parts.push(this.drop(true));
    } else if (kind === 'snow') {
      for (let i = 0; i < n(70); i++) this.parts.push(this.flake(true));
    }
    this.stars = [];
    if (this.night && (kind === 'clear' || kind === 'partly')) {
      for (let i = 0; i < Math.round(110 * area); i++) {
        this.stars.push({ x: rand(0, this.w), y: rand(0, this.h * 0.75), r: rand(0.4, 1.4), p: rand(0, Math.PI * 2), s: rand(0.6, 2) });
      }
    }
    this.clouds = [];
    const cloudN = { partly: 4, cloudy: 7, rain: 6, storm: 7, snow: 5, fog: 9, clear: 0 }[kind] || 0;
    for (let i = 0; i < cloudN; i++) {
      this.clouds.push({
        x: rand(-0.3, 1.1) * this.w, y: kind === 'fog' ? rand(0.15, 0.95) * this.h : rand(-0.05, 0.45) * this.h,
        rx: rand(160, 320), ry: kind === 'fog' ? rand(40, 70) : rand(60, 110), v: rand(4, 12) * (Math.random() < 0.5 ? 1 : 0.6),
        a: kind === 'fog' ? rand(0.05, 0.1) : rand(0.04, 0.09),
      });
    }
  }

  drop(anywhere) {
    const z = rand(0.4, 1);
    return { x: rand(-50, this.w + 50), y: anywhere ? rand(-this.h, this.h) : rand(-120, -10), z, len: 10 + z * 16, v: 520 + z * 520 };
  }

  flake(anywhere) {
    const z = rand(0.3, 1);
    return { x: rand(0, this.w), y: anywhere ? rand(-this.h, this.h) : rand(-40, -5), z, r: 0.8 + z * 2.2, v: 25 + z * 55, p: rand(0, 6.28), sway: rand(10, 30) };
  }

  start() {
    if (this.running) return;
    this.running = true; this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  stop() { this.running = false; }

  frame(t) {
    if (!this.running) return;
    const dt = t - this.last;
    if (dt >= 32) { // ~30 fps is plenty for weather and halves the battery cost
      this.last = t;
      this.draw(Math.min(dt, 64) / 1000, t / 1000);
    }
    requestAnimationFrame(this.frame);
  }

  draw(dt, time = 0) {
    const g = this.g, w = this.w, h = this.h;
    g.clearRect(0, 0, w, h);

    if (this.kind === 'clear' && !this.night) {
      // a soft sun glow with slowly turning rays
      const gx = w * 0.82, gy = h * 0.08;
      const grd = g.createRadialGradient(gx, gy, 0, gx, gy, w * 0.9);
      grd.addColorStop(0, 'rgba(255,240,200,0.55)');
      grd.addColorStop(0.25, 'rgba(255,225,160,0.16)');
      grd.addColorStop(1, 'rgba(255,220,150,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
      g.save(); g.translate(gx, gy); g.rotate(time * 0.02);
      for (let i = 0; i < 12; i++) {
        g.rotate(Math.PI / 6);
        g.fillStyle = 'rgba(255,245,220,0.035)';
        g.beginPath(); g.moveTo(0, 0); g.lineTo(w * 1.2, -40); g.lineTo(w * 1.2, 40); g.closePath(); g.fill();
      }
      g.restore();
    }

    for (const s of this.stars) {
      const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(s.p + time * s.s));
      g.fillStyle = `rgba(255,255,255,${(a * 0.85).toFixed(3)})`;
      g.beginPath(); g.arc(s.x, s.y, s.r, 0, 6.283); g.fill();
    }
    if (this.stars.length) {
      if (!this.shoot && Math.random() < dt * 0.06) {
        this.shoot = { x: rand(w * 0.2, w), y: rand(0, h * 0.3), vx: -rand(500, 700), vy: rand(180, 260), life: 0.9 };
      }
      if (this.shoot) {
        const s = this.shoot;
        s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
        const grd = g.createLinearGradient(s.x, s.y, s.x - s.vx * 0.12, s.y - s.vy * 0.12);
        grd.addColorStop(0, `rgba(255,255,255,${Math.max(0, s.life).toFixed(2)})`);
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.strokeStyle = grd; g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(s.x - s.vx * 0.12, s.y - s.vy * 0.12); g.stroke();
        if (s.life <= 0) this.shoot = null;
      }
    }

    for (const c of this.clouds) {
      c.x += c.v * dt;
      if (c.x - c.rx > w) c.x = -c.rx * 1.2;
      const tone = this.night ? '200,215,240' : '255,255,255';
      const grd = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.rx);
      grd.addColorStop(0, `rgba(${tone},${c.a})`);
      grd.addColorStop(1, `rgba(${tone},0)`);
      g.fillStyle = grd;
      g.save(); g.translate(c.x, c.y); g.scale(1, c.ry / c.rx); g.translate(-c.x, -c.y);
      g.beginPath(); g.arc(c.x, c.y, c.rx, 0, 6.283); g.fill();
      g.restore();
    }

    if (this.kind === 'rain' || this.kind === 'storm') {
      g.lineCap = 'round';
      const slant = 0.18;
      for (let i = 0; i < this.parts.length; i++) {
        const d = this.parts[i];
        d.y += d.v * dt; d.x += d.v * slant * dt;
        if (d.y > h + 20) this.parts[i] = this.drop(false);
        g.strokeStyle = `rgba(190,215,255,${(0.18 + d.z * 0.32).toFixed(2)})`;
        g.lineWidth = 0.6 + d.z * 0.9;
        g.beginPath(); g.moveTo(d.x, d.y); g.lineTo(d.x - d.len * slant, d.y - d.len); g.stroke();
      }
    } else if (this.kind === 'snow') {
      for (let i = 0; i < this.parts.length; i++) {
        const f = this.parts[i];
        f.y += f.v * dt; f.p += dt * 1.2;
        const x = f.x + Math.sin(f.p) * f.sway;
        if (f.y > h + 10) this.parts[i] = this.flake(false);
        g.fillStyle = `rgba(255,255,255,${(0.35 + f.z * 0.55).toFixed(2)})`;
        g.beginPath(); g.arc(x, f.y, f.r, 0, 6.283); g.fill();
      }
    }

    if (this.kind === 'storm') {
      if (this.flash <= 0 && Math.random() < dt * 0.12) this.flash = 1;
      if (this.flash > 0) {
        const f = this.flash;
        const a = f > 0.85 ? 0.5 : f > 0.7 ? 0.08 : f > 0.55 ? 0.35 : f * 0.25;
        g.fillStyle = `rgba(225,230,255,${a.toFixed(3)})`; g.fillRect(0, 0, w, h);
        this.flash -= dt * 1.6;
      }
    }
  }
}
