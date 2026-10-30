// Procedural car audio. Everything is synthesised in one AudioWorklet:
// inline-4 firing pulses -> header + exhaust pipe waveguides -> muffler, plus intake, turbo,
// blow-off valve, afterfire pops, tyre squeal, gravel crunch, wind and road roar.

const WORKLET = /* js */ `
const TAU = Math.PI * 2;
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q, sr, gainDb = 0) {
    f = Math.min(Math.max(f, 10), sr * 0.45);
    const w = TAU * f / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else { // peaking
      const A = Math.pow(10, gainDb / 40);
      b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  p(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}
class Pipe { // waveguide tube: delay line with lossy, lowpassed, inverting reflection at the open end
  constructor(maxLen) { this.buf = new Float32Array(maxLen); this.i = 0; this.lp = 0; }
  p(x, delay, fb, damp) {
    const n = this.buf.length;
    let r = this.i - delay; if (r < 0) r += n;
    const ri = Math.floor(r), fr = r - ri;
    const d = this.buf[ri] * (1 - fr) + this.buf[(ri + 1) % n] * fr;
    this.lp += (d - this.lp) * damp;
    const y = x + fb * this.lp;
    this.buf[this.i] = y; this.i = (this.i + 1) % n;
    return y;
  }
}
const rnd = () => Math.random() * 2 - 1;

class CarSynth extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { rpm: 850, load: 0, thr: 0, boost: 0, fuelCut: 0, speed: 0, squeal: 0, pitch: 0, scrub: 0, wet: 0, crunch: 0, scrape: 0, master: 0.9, wind: 1 };
    this.s = { rpm: 850, load: 0, thr: 0, boost: 0, speed: 0, squeal: 0, pitch: 0, scrub: 0, wet: 0, crunch: 0, scrape: 0 };
    this.phase = 0;
    this.cyl = 4; this.sport = 0; // 1.6 turbo four until the engine message arrives
    this.pulseT = 1; this.pulseAmp = 0; this.pulseLen = 0.004; this.pulseNoise = 0;
    this.cylGain = [1.0, 0.97, 1.03, 0.99];
    this.cylOff = [0, 0.003, -0.002, 0.002];
    this.header = new Pipe(4096);
    this.pipe = new Pipe(8192);
    this.pipe2 = new Pipe(8192);
    this.muff = new Biquad(); this.muff2 = new Biquad(); this.body = new Biquad(); this.reso = new Biquad();
    this.dcx = 0; this.dcy = 0;
    this.intake = new Biquad(); this.intake2 = new Biquad();
    this.sqNoise = new Biquad(); this.scrubF = new Biquad(); this.wetF = new Biquad(); this.crLo = new Biquad();
    this.thumpF = new Biquad(); this.hitF = new Biquad();
    this.hornF = new Biquad(); this.hornF2 = new Biquad(); this.hornOn = 0; this.hornEnv = 0; this.hornPh1 = 0; this.hornPh2 = 0;
    this.cr = new Biquad(); this.wind = new Biquad(); this.road = new Biquad(); this.bov = new Biquad(); this.roar = new Biquad(); this.roar2 = new Biquad();
    this.popEnv = 0; this.pops = 0; this.bovEnv = 0; this.bovAmt = 0; this.turboPh = 0;
    this.clunk = 0; this.click = 0; this.hit = 0;
    // crash: body thump + bank of ringing panel resonances excited by crackling grains + glass
    this.crash = 0; this.crashGrain = 0; this.glass = 0; this.glassGrain = 0; this.boom = 0;
    this.panels = Array.from({ length: 6 }, () => new Biquad()); this.panelF = [];
    this.boomF = new Biquad(); this.glassF = new Biquad(); this.scrapeF = new Biquad(); this.scrapeG = 0;
    // tyre squeal: noise through narrow resonances (fundamental + 2 partials) that wander in pitch,
    // with a rough chattering amplitude (tread stick-slip) and broadband rubber scrub underneath
    this.sqRes = [new Biquad(), new Biquad(), new Biquad()]; this.sqG = [0, 0, 0]; this.sqJit = 0; this.sqJitT = 0; this.sqJitS = 0;
    this.sqAMf = new Biquad(); this.scrubLo = new Biquad();
    // crash layers: impact crack, crumple, debris rattle, glass (hiss + tinkle grains)
    this.impact = 0; this.impactF = new Biquad(); this.debris = 0; this.debrisG = 0; this.debrisF = new Biquad();
    this.glassRes = [0, 1, 2, 3].map(() => new Biquad()); this.glassKick = [0, 0, 0, 0]; this.glassK = 0; this.glassHiss = 0; this.glassHissF = new Biquad();
    this.fl = 0; this.flT = 0; this.crGrain = 0; this.crLoG = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.pop) { this.pops += d.pop; }
      if (d.blowoff) { this.bovEnv = 1; this.bovAmt = d.blowoff; }
      if (d.clunk) { this.clunk = 1; this.click = 1; }
      if (d.hit) { this.hit = Math.min(1, this.hit + d.hit); }
      if (d.horn !== undefined) this.hornOn = d.horn ? 1 : 0;
      if (d.sleep !== undefined) this.sleep = d.sleep;
      if (d.engine) { // cylinder count + exhaust character; a cross-plane V8 fires its banks unevenly (the burble)
        this.cyl = d.engine.cyl; this.sport = d.engine.sport;
        this.cylGain = Array.from({ length: this.cyl }, (_, k) => 1 + (k % 2 ? -0.06 : 0.05) + (Math.random() - 0.5) * 0.06);
        const cross = this.cyl === 8 ? [0, 0.045, -0.03, 0.05, 0, -0.045, 0.03, -0.05] : null;
        this.cylOff = Array.from({ length: this.cyl }, (_, k) => (cross ? cross[k] : (Math.random() - 0.5) * 0.008));
      }
      if (d.crash) {
        const I = Math.min(1, d.crash);
        this.crash = Math.max(this.crash, I); this.boom = Math.max(this.boom, I);
        this.impact = Math.max(this.impact, I); this.debris = Math.max(this.debris, I * 0.7);
        if (d.glass) { this.glass = Math.max(this.glass, d.glass); this.glassHiss = Math.max(this.glassHiss, d.glass); }
        // a fresh set of panel resonances per impact so no two crashes sound the same; low Q: crumpling
        // sheet metal and plastic, not ringing bells
        this.panelF = this.panels.map(() => 140 + Math.random() * Math.random() * 3400);
        this.panels.forEach((b, i) => b.set('bp', this.panelF[i], 1.8 + Math.random() * 3.5, sampleRate));
      }
      Object.assign(this.p, d.params || {});
    };
    this.block = 0;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    if (this.sleep) { L.fill(0); R.fill(0); return true; } // a far-away car: no synthesis at all
    const sr = sampleRate;
    const P = this.p, S = this.s;
    // per-block filter updates
    const loadF = S.load;
    const sp = this.sport || 0;
    this.muff.set('lp', 380 + 900 * sp + (1100 + 2200 * sp) * loadF * loadF + S.rpm * (0.1 + 0.2 * sp), 0.7, sr); // silencers: muffled SUV .. open V8
    this.muff2.set('lp', 3800 + 2000 * loadF, 0.6, sr);
    this.body.set('peak', 55 + S.rpm * 0.009, 1.2, sr, 9); // cabin boom at the 2nd firing order
    this.reso.set('peak', 180 + S.rpm * 0.03, 1.8, sr, 2 + 2 * loadF);
    this.intake.set('bp', 600 + S.rpm * 0.25, 1.2, sr); // deeper induction hum
    this.intake2.set('bp', 3200 + S.boost * 1800, 3, sr);
    this.sqNoise.set('bp', 2300 + 900 * S.pitch, 0.8, sr);
    this.scrubF.set('bp', 700 + S.speed * 6, 1.1, sr);
    this.wetF.set('hp', 2600, 0.7, sr);
    this.cr.set('bp', 1400, 0.9, sr); this.crLo.set('lp', 260, 0.8, sr);
    this.thumpF.set('lp', 150, 0.9, sr); this.hitF.set('lp', 180, 0.8, sr);
    this.hornF.set('bp', 1900, 1.1, sr); this.hornF2.set('peak', 420, 2, sr, 6);
    this.boomF.set('lp', 95, 0.9, sr); this.glassF.set('bp', 5200, 2.5, sr); this.scrapeF.set('bp', 1500 + S.scrape * 1500, 1.4, sr);
    // squeal pitch: a slow drift plus fast jitter (the contact patch never squeals at one steady note)
    this.sqJitS += (rnd() * 0.07 - this.sqJitS) * 0.01;
    this.sqJitT += (rnd() * 0.035 - this.sqJitT) * 0.25;
    const sqF0 = (600 + 560 * S.pitch) * (1 + this.sqJitS + this.sqJitT);
    { const H = [1, 2.03, 3.11], Q = [26, 20, 14], G = [1, 0.42, 0.18];
      for (let k = 0; k < 3; k++) { const f = sqF0 * H[k]; this.sqRes[k].set('bp', f, Q[k], sr); this.sqG[k] = G[k] * Math.sqrt((sr / 2) / (f / Q[k])) * 0.9; } }
    this.sqAMf.set('lp', 55, 0.7, sr);
    this.scrubLo.set('bp', 850 + 500 * S.pitch, 0.55, sr);
    this.impactF.set('lp', 3200, 0.6, sr);
    this.debrisF.set('bp', 1800 + Math.random() * 4200, 3, sr);
    this.glassHissF.set('hp', 4500, 0.7, sr);
    this.wind.set('lp', 250 + S.speed * 18, 0.6, sr);
    this.road.set('lp', 90 + S.speed * 2.2, 0.9, sr);
    this.roar.set('bp', 380 + S.speed * 6, 0.7, sr); this.roar2.set('lp', 1400, 0.7, sr);
    this.bov.set('bp', 2400 + this.bovEnv * 2500, 1.2, sr);

    // pipe tuning: header ~0.7 m, main pipe ~2.6 m, tailpipe branch ~1.1 m (round-trip delays)
    const c = 343 * (1 + 0.25 * loadF); // hot gas is faster
    const dHead = (2 * 0.6 / c) * sr, dPipe = (2 * 3.6 / c) * sr, dPipe2 = (2 * 1.6 / c) * sr; // long SUV exhaust run

    // slow motion: the synth runs on simulated time (one synth sample per 1/timeScale output samples,
    // interpolated), so everything slows down together: pitch, revs, envelopes, crashes
    const ts = Math.min(1, Math.max(0.01, P.timeScale ?? 1));
    for (let i = 0; i < L.length; i++) {
      this.tAcc = (this.tAcc || 0) + ts;
      if (this.tAcc < 1) { const f = this.tAcc; L[i] = this.oL0 + (this.oL1 - this.oL0) * f; R[i] = this.oR0 + (this.oR1 - this.oR0) * f; continue; }
      this.tAcc -= 1;
      // parameter smoothing (~8 ms)
      S.rpm += (P.rpm - S.rpm) * 0.0028;
      S.load += (P.load - S.load) * 0.0016;
      S.thr += (P.thr - S.thr) * 0.002;
      S.boost += (P.boost - S.boost) * 0.001;
      S.speed += (P.speed - S.speed) * 0.0005;
      S.squeal += (P.squeal - S.squeal) * 0.0012;
      S.pitch += (P.pitch - S.pitch) * 0.0008;
      S.scrub += (P.scrub - S.scrub) * 0.0015;
      S.wet += (P.wet - S.wet) * 0.0015;
      S.scrape += (P.scrape - S.scrape) * 0.003;
      S.crunch += (P.crunch - S.crunch) * 0.002;

      // ---- crank cycle: 720 deg; 4 cylinders fire every 180 deg ----
      const cps = S.rpm / 120;
      const prev = this.phase;
      this.phase += cps / sr;
      const wrapped = this.phase >= 1;
      if (wrapped) this.phase -= 1;
      for (let k = 0; k < this.cyl; k++) {
        const fp = k / this.cyl + this.cylOff[k] * 0.5 + 0.01;
        const crossed = wrapped ? (fp > prev || fp <= this.phase) : (fp > prev && fp <= this.phase);
        if (!crossed) continue;
        const firing = !P.fuelCut;
        const ld = S.load;
        let a = firing ? (0.22 + 0.78 * ld) * this.cylGain[k] * (1 + 0.14 * rnd()) : 0.06 * (1 + 0.3 * rnd());
        // lumpy idle character
        if (S.rpm < 1100) a *= 1 + 0.25 * rnd();
        this.pulseAmp = a;
        this.pulseT = 0;
        const period = 1 / (cps * this.cyl);
        this.pulseLen = Math.max(0.0012, Math.min(0.009, period * (0.55 + 0.25 * ld)));
        this.pulseNoise = firing ? 0.25 + 0.5 * ld : 0.05;
        if (this.pops > 0 && Math.random() < 0.6) { this.popEnv = 1; this.pops--; }
      }

      // pulse shape: fast-rise, exponential tail blowdown + combustion noise
      let ex = 0;
      if (this.pulseT < this.pulseLen * 3) {
        const u = this.pulseT / this.pulseLen;
        const env = u < 0.25 ? u / 0.25 : Math.exp(-(u - 0.25) * 2.2);
        ex = this.pulseAmp * env * (1 + this.pulseNoise * rnd());
        this.pulseT += 1 / sr;
      }
      // afterfire pop: sharp crack + noisy burble into the same exhaust
      if (this.popEnv > 0.001) {
        ex += this.popEnv * (1.6 * rnd() + (this.popEnv > 0.85 ? 2.2 : 0));
        this.popEnv *= 0.9962;
      }

      // ---- exhaust system ----
      let h = this.header.p(ex, dHead, -0.42, 0.55);
      let y = this.pipe.p(h, dPipe, -0.55, 0.25);
      y += 0.5 * this.pipe2.p(h, dPipe2, -0.4, 0.35);
      const raw = y;
      y = this.muff.p(y) + raw * ((0.015 + 0.03 * S.load) * (1 - this.sport) + (0.06 + 0.1 * S.load) * this.sport); // raw exhaust: a trace (SUV) .. plenty (V8)
      y = this.muff2.p(y);
      y = this.body.p(y);
      y = this.reso.p(y);
      // DC blocker
      const dc = y - this.dcx + 0.995 * this.dcy; this.dcx = y; this.dcy = dc; y = dc;
      let eng = Math.tanh(y * (1.3 + 0.9 * S.load)) * 0.75; // clean, not raspy

      // intake + mechanical
      const firingMod = 0.6 + 0.4 * Math.max(0, Math.sin(this.phase * TAU * this.cyl));
      const n = rnd();
      eng += this.intake.p(n) * (0.03 + 0.16 * S.thr * S.rpm / 6500) * firingMod; // turbo four: intake hum + whoosh is most of what you hear
      eng += this.intake2.p(n) * 0.05 * S.boost * S.thr;
      // turbo whistle
      this.turboPh += (1400 + 4200 * S.boost * S.boost) / sr;
      if (this.turboPh > 1) this.turboPh -= 1;
      eng += Math.sin(this.turboPh * TAU) * 0.004 * S.boost * (0.3 + S.thr);
      // blow-off valve "pssh"
      if (this.bovEnv > 0.001) {
        eng += this.bov.p(rnd()) * this.bovEnv * 0.12 * this.bovAmt; // stock recirculating valve: a soft whoosh
        this.bovEnv *= 0.99985 - 0.00008;
      }
      // gearshift: dull driveline thump + tiny selector click
      let fx = 0;
      // horn: a pair of disc horns (~410 + 500 Hz), clipped hard so they buzz, through the bumper's resonances
      this.hornEnv += ((this.hornOn ? 1 : 0) - this.hornEnv) * (this.hornOn ? 0.004 : 0.0015);
      if (this.hornEnv > 0.001) {
        this.hornPh1 = (this.hornPh1 + 412 / sr) % 1; this.hornPh2 = (this.hornPh2 + 498 / sr) % 1;
        const h = Math.tanh(Math.sin(this.hornPh1 * TAU) * 5) + 0.8 * Math.tanh(Math.sin(this.hornPh2 * TAU) * 5);
        fx += this.hornF2.p(this.hornF.p(h) * 2.2 + h * 0.25) * 0.16 * this.hornEnv;
      }
      if (this.clunk > 0.001) { fx += this.thumpF.p(rnd()) * this.clunk * 0.9; this.clunk *= 0.99955; }
      if (this.click > 0.001) { fx += rnd() * this.click * 0.05; this.click *= 0.994; }
      if (this.hit > 0.001) { fx += this.hitF.p(rnd()) * this.hit * 3; this.hit *= 0.9993; }

      // ---- crashes ----
      // the hit itself: a short, hard broadband crack
      if (this.impact > 0.001) { fx += this.impactF.p(rnd()) * this.impact * 2.6; this.impact *= 0.9982; }
      // body thud (the mass of the car stopping)
      if (this.boom > 0.001) { fx += this.boomF.p(rnd()) * this.boom * 9; this.boom *= 0.99965; }
      // crumple: dense crackling grains of random size through low-Q panel resonances
      if (this.crash > 0.002) {
        if (Math.random() < this.crash * 0.05) this.crashGrain = Math.pow(Math.random(), 1.4);
        const g = rnd() * this.crashGrain * this.crash;
        let ring = 0;
        for (const b of this.panels) ring += b.p(g);
        fx += ring * 1.6 + g * 0.45;
        this.crashGrain *= 0.993;
        this.crash *= 0.99992;
      }
      // bits of plastic and trim skittering away: sparse sharp ticks
      if (this.debris > 0.002) {
        if (Math.random() < this.debris * 0.0025) this.debrisG = 0.3 + Math.random() * 0.7;
        fx += this.debrisF.p(rnd() * this.debrisG) * this.debris * 1.1;
        this.debrisG *= 0.982; this.debris *= 0.99997;
      }
      // glass: a burst of hiss as it shatters, then many little tinkling pieces at random pitches
      if (this.glass > 0.002) {
        if (this.glassHiss > 0.001) { fx += this.glassHissF.p(rnd()) * this.glassHiss * 0.5; this.glassHiss *= 0.9994; }
        if (Math.random() < this.glass * 0.004) {
          this.glassK = (this.glassK + 1) % 4;
          this.glassRes[this.glassK].set('bp', 2600 + Math.random() * 7000, 18 + Math.random() * 30, sr);
          this.glassKick[this.glassK] = 0.4 + Math.random() * 0.6;
        }
        for (let k = 0; k < 4; k++) if (this.glassKick[k] > 0.001) { fx += this.glassRes[k].p(rnd() * this.glassKick[k]) * this.glass * 3; this.glassKick[k] *= 0.992; }
        this.glass *= 0.99995;
      }
      if (S.scrape > 0.002) {
        if (Math.random() < 0.02) this.scrapeG = 0.5 + Math.random() * 0.5;
        fx += this.scrapeF.p(rnd()) * S.scrape * (0.5 + 0.5 * this.scrapeG) * 0.5;
        this.scrapeG *= 0.999;
      }

      // ---- tyres ----
      let tyre = 0;
      const sqA = S.squeal > 0.002 ? Math.pow(Math.min(1.2, S.squeal), 1.3) : 0;
      if (sqA > 0) {
        const exc = rnd();
        const am = 0.5 + 0.5 * Math.tanh(this.sqAMf.p(rnd()) * 40); // chattering, never steady
        let tone = 0;
        for (let k = 0; k < 3; k++) tone += this.sqRes[k].p(exc) * this.sqG[k];
        tyre += sqA * (0.13 * Math.tanh(tone * 1.2) * am + 0.035 * this.scrubLo.p(exc) + 0.01 * this.sqNoise.p(exc));
      }
      const nz = rnd();
      if (S.scrub > 0.002) tyre += this.scrubF.p(nz) * S.scrub * 0.05; // tyres working near the limit
      if (S.wet > 0.002) tyre += this.wetF.p(nz) * S.wet * 0.14; // spray hiss
      // gravel/grass: dense small grains + low rumble from stones hitting the arches
      let cr = 0;
      if (S.crunch > 0.01) {
        if (Math.random() < S.crunch * 0.09) this.crGrain = 0.4 + Math.random() * 0.6;
        if (Math.random() < S.crunch * 0.004) this.crLoG = 1;
        cr = this.cr.p(rnd() * this.crGrain) * S.crunch * 1.1 + this.crLo.p(rnd() * this.crLoG) * S.crunch * 1.6;
        this.crGrain *= 0.97; this.crLoG *= 0.995;
      }
      const sq = tyre;
      // wind + road roar
      const sp = S.speed;
      const wind = this.wind.p(rnd()) * Math.min(1, (sp * sp) / 2500) * 0.35 * P.wind;
      const rn = rnd();
      // tyre roar on the road surface: broadband mid noise that rises with speed, plus a low rumble
      const road = this.road.p(rn) * Math.min(1, sp / 40) * 0.3 + this.roar2.p(this.roar.p(rn)) * Math.min(1, sp / 35) * 0.22;

      const mix = (eng + fx + sq + cr + wind + road) * P.master;
      // tiny stereo spread on tyres/wind
      this.oL0 = this.oL1 || 0; this.oR0 = this.oR1 || 0;
      this.oL1 = Math.max(-1, Math.min(1, mix + 0.05 * wind));
      this.oR1 = Math.max(-1, Math.min(1, mix - 0.05 * wind));
      L[i] = ts < 1 ? this.oL0 + (this.oL1 - this.oL0) * this.tAcc : this.oL1;
      R[i] = ts < 1 ? this.oR0 + (this.oR1 - this.oR0) * this.tAcc : this.oR1;
    }
    return true;
  }
}
registerProcessor('car-synth', CarSynth);
`;

// One AudioContext + master bus shared by every car's synth.
let shared = null;
// master level: volume setting, mute, and a duck while the pause menu is open
const lvl = { volume: 0.8, muted: false, duck: false };
const applyLevel = () => { if (shared) shared.master.gain.setTargetAtTime(lvl.muted ? 0 : lvl.volume * (lvl.duck ? 0.15 : 1), shared.ctx.currentTime, 0.05); };
async function bus() {
  if (shared) return shared;
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10; comp.ratio.value = 3; comp.attack.value = 0.003; comp.release.value = 0.15;
  const master = ctx.createGain(); master.gain.value = lvl.muted ? 0 : lvl.volume;
  comp.connect(master).connect(ctx.destination);
  shared = { ctx, input: comp, master };
  return shared;
}

export class CarAudio {
  // spatial: other cars are heard through distance attenuation + stereo panning
  // engine: { cyl, sport } - cylinder count, and how open the exhaust is (0 muffled SUV .. 1 loud V8)
  constructor({ spatial = false, engine = {} } = {}) { this.engine = engine; this.spatial = spatial; this.node = null; this.ready = false; this.lastPops = 0; this.wasBlowoff = 0; this.lastGear = null; }
  async start() {
    const b = await bus();
    if (b.ctx.state !== 'running') await b.ctx.resume();
    if (this.node) return;
    this.ctx = b.ctx;
    this.node = new AudioWorkletNode(b.ctx, 'car-synth', { outputChannelCount: [2] });
    this.out = b.ctx.createGain();
    this.pan = b.ctx.createStereoPanner();
    this.node.connect(this.out).connect(this.pan).connect(b.input);
    if (this.spatial) this.node.port.postMessage({ params: { wind: 0 } }); // wind noise is the listener's own
    this.node.port.postMessage({ engine: { cyl: this.engine.cyl || 4, sport: this.engine.sport || 0 } });
    this.ready = true;
  }
  // far cars are put to sleep (the synth outputs silence without computing anything)
  setActive(on) { if (this.ready && on !== (this.active ?? true)) { this.active = on; this.node.port.postMessage({ sleep: !on }); } }
  setEngine(engine) { this.engine = engine; if (this.ready) this.node.port.postMessage({ engine: { cyl: engine.cyl || 4, sport: engine.sport || 0 } }); }
  setMuted(m) { lvl.muted = m; applyLevel(); }
  static setVolume(v) { lvl.volume = v; applyLevel(); }
  static setDuck(d) { lvl.duck = d; applyLevel(); }
  // listener-relative placement: distance in metres, side in [-1 (left), 1 (right)]
  place(dist, side) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(1 / (1 + Math.max(0, dist - 3) / 6), t, 0.05);
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, side)) * 0.8, t, 0.05);
  }
  // police siren: 'wail' (slow sweep), 'yelp' (fast sweep), 'hilo' (two-tone) or 'off'. A square + a
  // detuned saw through a band-pass and a soft clipper (horn speaker), pitch swept by an LFO.
  siren(mode) {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime;
    if (!this.sir) {
      const g = c.createGain(); g.gain.value = 0;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 0.8;
      const ws = c.createWaveShaper(), curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.5); }
      ws.curve = curve;
      const o1 = c.createOscillator(), o2 = c.createOscillator(), lfo = c.createOscillator(), depth = c.createGain();
      o1.type = 'square'; o2.type = 'sawtooth'; o2.detune.value = 9;
      lfo.connect(depth); depth.connect(o1.frequency); depth.connect(o2.frequency);
      o1.connect(bp); o2.connect(bp); bp.connect(ws).connect(g).connect(this.out);
      for (const o of [o1, o2, lfo]) o.start();
      this.sir = { g, o1, o2, lfo, depth };
    }
    const s = this.sir;
    if (mode === 'off') { s.g.gain.setTargetAtTime(0, t, 0.08); return; }
    const [f, d, rate, wave] = { wail: [930, 390, 0.2, 'triangle'], yelp: [980, 400, 3.2, 'triangle'], hilo: [860, 100, 0.85, 'square'] }[mode];
    for (const o of [s.o1, s.o2]) o.frequency.setValueAtTime(f, t);
    s.depth.gain.setValueAtTime(d, t); s.lfo.frequency.setValueAtTime(rate, t); s.lfo.type = wave;
    s.g.gain.setTargetAtTime(0.13, t, 0.05);
  }
  crash(intensity, glass) { if (this.ready) this.node.port.postMessage({ crash: intensity, glass }); }
  horn(on) { if (this.ready && on !== this.hornState) { this.hornState = on; this.node.port.postMessage({ horn: on }); } }
  update(car, extra) {
    if (!this.ready || this.active === false) return;
    const e = car.eng;
    const msg = {
      params: {
        rpm: e.rpm, load: e.load, thr: e.throttle, boost: e.boost, fuelCut: e.fuelCut ? 1 : 0,
        timeScale: extra.timeScale ?? 1, speed: car.speed, squeal: extra.squeal, pitch: extra.pitch, scrub: extra.scrub, wet: extra.wet, crunch: extra.crunch, scrape: extra.scrape || 0,
      },
    };
    if (e.pops !== this.lastPops) { msg.pop = e.pops - this.lastPops; this.lastPops = e.pops; }
    if (e.blowoff > 0 && this.wasBlowoff <= 0) msg.blowoff = Math.min(1, e.blowoff);
    this.wasBlowoff = e.blowoff;
    if (this.lastGear !== null && car.gear !== this.lastGear) msg.clunk = 1;
    this.lastGear = car.gear;
    if (extra.hit) msg.hit = extra.hit;
    this.node.port.postMessage(msg);
  }
}
