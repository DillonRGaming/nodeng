// Driving HUD in the menus' style: a frosted dark rounded panel, white accents. Speed (big) + units,
// the gear in a white box like the selected tab in the menus, rpm, a segmented rev bar with the red
// zone, and small pill tags for the drivetrain / driver aids / lamps that only light up when acting.

const W = 300, H = 92; // design units
const FONT = '"Segoe UI", "Noto Sans", ui-sans-serif, system-ui, sans-serif'; // matches the menus
const INK = '#111214', DIM = 'rgba(238,240,242,0.45)', LINE = 'rgba(255,255,255,0.08)', RED = '#e8452f';

export class Hud {
  constructor(canvas) {
    this.c = canvas; this.g = canvas.getContext('2d');
    this.units = 'kmh';
    this.t = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  resize() {
    this.scale = Math.max(0.75, Math.min(1.1, innerWidth / 1400));
    this.dpr = Math.min(devicePixelRatio, 2);
    this.c.style.width = W * this.scale + 'px'; this.c.style.height = H * this.scale + 'px';
    this.c.width = Math.round(W * this.scale * this.dpr); this.c.height = Math.round(H * this.scale * this.dpr);
  }
  draw(car, dt, { gearLabel, lamps = {} }) {
    this.t += dt;
    const g = this.g, k = this.scale * this.dpr, e = car.eng, P = car.P;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(22,23,27,0.74)'; g.beginPath(); g.roundRect(0.5, 0.5, W - 1, H - 1, 8); g.fill();
    g.strokeStyle = LINE; g.lineWidth = 1; g.stroke();

    // speed
    const kmh = car.speed * 3.6, v = this.units === 'mph' ? kmh / 1.609 : kmh;
    g.textBaseline = 'alphabetic'; g.textAlign = 'right'; g.fillStyle = '#f1f2f4';
    g.font = `700 38px ${FONT}`; g.fillText(String(Math.round(v)), 128, 50);
    g.textAlign = 'left'; g.fillStyle = DIM; g.font = `700 10px ${FONT}`;
    g.fillText(this.units === 'mph' ? 'MPH' : 'KM/H', 134, 50);

    // gear box (white, dark text) + auto/manual and rpm beside it
    const gx = 196, gy = 14, gw = 40, gh = 40;
    g.fillStyle = e.fuelCut ? RED : '#ffffff'; g.beginPath(); g.roundRect(gx, gy, gw, gh, 6); g.fill();
    g.fillStyle = INK; g.textAlign = 'center'; g.font = `800 24px ${FONT}`; g.fillText(gearLabel, gx + gw / 2, gy + 29);
    g.textAlign = 'left'; g.fillStyle = DIM; g.font = `700 10px ${FONT}`;
    g.fillText(car.autoShift ? 'AUTO' : 'MANUAL', gx + gw + 10, gy + 14);
    g.fillStyle = '#e6e8eb'; g.font = `700 13px ${FONT}`;
    g.fillText(String(Math.round(e.rpm / 50) * 50), gx + gw + 10, gy + 31);
    g.fillStyle = DIM; g.font = `700 9px ${FONT}`; g.fillText('RPM', gx + gw + 10, gy + 42);

    // segmented rev bar, red zone tinted
    const x0 = 14, x1 = W - 14, y = 62, N = 34, gap = 2, maxR = P.limiterRpm + 300, sw = (x1 - x0 - gap * (N - 1)) / N;
    for (let i = 0; i < N; i++) {
      const r = ((i + 0.5) / N) * maxR, on = r <= e.rpm, red = r >= P.redlineRpm;
      g.fillStyle = on ? (red || e.rpm > P.redlineRpm ? RED : '#ffffff') : red ? 'rgba(232,69,47,0.28)' : 'rgba(255,255,255,0.1)';
      g.beginPath(); g.roundRect(x0 + i * (sw + gap), y, sw, 5, 1.5); g.fill();
    }

    // pill tags: dim when idle, lit when acting, red when switched off
    const absOn = car.wheels.some((w) => w.absF < 0.95), tcsOn = car.tcsCut > 0.02 || car.escActive > 0;
    const tags = [
      [car.mode, true],
      ['TCS', tcsOn, !car.tcs],
      ['ABS', absOn, !car.abs],
      ['◀', lamps.left], ['▶', lamps.right],
      [lamps.head === 2 ? 'HI' : 'LO', lamps.head > 0],
    ];
    g.font = `800 9px ${FONT}`; g.textAlign = 'center';
    let tx = 14;
    for (const [label, on, off] of tags) {
      const text = off ? label + ' OFF' : label, tw = g.measureText(text).width + 12;
      g.fillStyle = off ? 'rgba(232,69,47,0.85)' : on ? '#ffffff' : 'rgba(255,255,255,0.08)';
      g.beginPath(); g.roundRect(tx, 73, tw, 13, 3); g.fill();
      g.fillStyle = off ? '#fff' : on ? INK : 'rgba(255,255,255,0.35)';
      g.fillText(text, tx + tw / 2, 83);
      tx += tw + 5;
    }
  }
}
