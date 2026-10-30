// Frame profiler for the debug overlay (F).
//  cpu: named sections timed with performance.now(), summed per frame, smoothed.
//  gpu: named sections timed with EXT_disjoint_timer_query_webgl2. Timer queries can't nest, so a
//       nested begin() closes the parent's query and reopens it afterwards: every section reports its
//       own (exclusive) GPU time. Results arrive a few frames late; each is smoothed per name.
//  graph: frame time and GPU time history, with 60 / 30 fps lines.

const SMOOTH = 0.08;

export class Profiler {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.cpu = new Map(); // name -> { acc, avg, max }
    this.gpu = new Map(); // name -> { avg }
    this.stack = []; // cpu: [name, t0]
    this.gstack = []; this.cur = null; // gpu: open section names, current query
    this.pending = []; // [{ q, name, frame }]
    this.frameGpu = new Map(); // frame -> { sum, left } (per-frame GPU total)
    this.gpuTotal = 0;
    this.hist = { dt: new Float32Array(240), gpu: new Float32Array(240), i: 0 };
    this.on = false; this.frame = 0; this.gpuTotal = 0;
  }

  // ---- cpu ----
  begin(name) { if (this.on) this.stack.push(name, performance.now()); }
  end() {
    if (!this.on || !this.stack.length) return;
    const t0 = this.stack.pop(), name = this.stack.pop();
    const s = this.cpu.get(name) || this.cpu.set(name, { acc: 0, avg: 0, max: 0 }).get(name);
    s.acc += performance.now() - t0;
  }

  // ---- gpu ----
  gbegin(name) {
    if (!this.on || !this.ext) return;
    this._close();
    this.gstack.push(name);
    this._open(name);
  }
  gend() {
    if (!this.on || !this.ext || !this.gstack.length) return;
    this._close();
    this.gstack.pop();
    if (this.gstack.length) this._open(this.gstack[this.gstack.length - 1]);
  }
  _open(name) {
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.cur = { q, name, frame: this.frame };
  }
  _close() {
    if (!this.cur) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.cur);
    const f = this.frameGpu.get(this.cur.frame) || this.frameGpu.set(this.cur.frame, { sum: 0, left: 0, by: new Map() }).get(this.cur.frame);
    f.left++;
    this.cur = null;
  }
  _poll() {
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length && gl.getQueryParameter(this.pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const p = this.pending.shift();
      const ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(p.q);
      const f = this.frameGpu.get(p.frame);
      if (disjoint) { if (f) this.frameGpu.delete(p.frame); continue; }
      if (!f) continue;
      // a section split by a nested one reports several pieces: sum them per frame before averaging
      f.sum += ms; f.by.set(p.name, (f.by.get(p.name) || 0) + ms);
      if (--f.left === 0) {
        this.gpuTotal = f.sum;
        for (const [name, v] of f.by) { const s = this.gpu.get(name) || this.gpu.set(name, { avg: v }).get(name); s.avg += (v - s.avg) * SMOOTH; }
        for (const [name, st] of this.gpu) if (!f.by.has(name)) st.avg -= st.avg * SMOOTH; // switched off: falls to 0
        this.frameGpu.delete(p.frame);
      }
    }
    if (this.pending.length > 200) { for (const p of this.pending.splice(0, 100)) gl.deleteQuery(p.q); this.frameGpu.clear(); }
  }

  // call once at the end of every frame
  endFrame(dt) {
    this.frame++;
    if (!this.on) return;
    for (const s of this.cpu.values()) { s.avg += (s.acc - s.avg) * SMOOTH; s.max = Math.max(s.acc, s.max * 0.995); s.acc = 0; }
    if (this.ext) this._poll();
    const h = this.hist; h.dt[h.i] = dt * 1000; h.gpu[h.i] = this.gpuTotal; h.i = (h.i + 1) % h.dt.length;
  }
  setOn(on) {
    if (on === this.on) return;
    this.on = on;
    if (!on) { // drop everything in flight so stale results don't land later
      if (this.cur) { this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.gl.deleteQuery(this.cur.q); this.cur = null; }
      for (const p of this.pending) this.gl.deleteQuery(p.q);
      this.pending = []; this.gstack = []; this.stack = []; this.frameGpu.clear();
    }
  }

  // ---- report ----
  table(map, order, total) {
    const bar = (ms) => '█'.repeat(Math.min(24, Math.round(ms * 2))) + (ms * 2 % 1 > 0.5 ? '▌' : '');
    let s = '';
    for (const name of order) {
      const v = map.get(name);
      if (!v) continue;
      s += `  ${name.padEnd(13)}${v.avg.toFixed(2).padStart(6)} ms${v.max !== undefined ? `  (pk ${v.max.toFixed(1).padStart(4)})` : '            '}  ${bar(v.avg)}\n`;
    }
    if (total === 'sum') total = order.reduce((t, n) => t + (map.get(n)?.avg || 0), 0);
    if (total !== undefined) s += `  ${'total'.padEnd(13)}${total.toFixed(2).padStart(6)} ms\n`;
    return s;
  }
  drawGraph(cv) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, h = this.hist, n = h.dt.length;
    const y = (ms) => H - Math.min(ms, 50) / 50 * H;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(18,20,24,0.7)'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.25)'; g.setLineDash([3, 3]); g.lineWidth = 1;
    for (const ms of [16.7, 33.3]) { g.beginPath(); g.moveTo(0, y(ms)); g.lineTo(W, y(ms)); g.stroke(); }
    g.setLineDash([]);
    g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = '9px monospace'; g.fillText('60', 2, y(16.7) - 2); g.fillText('30', 2, y(33.3) - 2);
    for (const [arr, col] of [[h.gpu, '#f5a623'], [h.dt, '#7fd6a4']]) {
      g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath();
      for (let k = 0; k < n; k++) { const v = arr[(h.i + k) % n], x = (k / (n - 1)) * W; k ? g.lineTo(x, y(v)) : g.moveTo(x, y(v)); }
      g.stroke();
    }
  }
}
