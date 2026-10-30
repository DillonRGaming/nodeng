// The game's menus, sim-sandbox style: frosted dark panels over the (blurred) live scene, bold uppercase
// headings, orange accents, picture tiles, and key hints in the corner.
//   title  - start screen: tab bar (Play / Garage / Settings / Controls, Q E to switch) + mode tiles
//   maps   - Freeroam > Map selector: map list + details (time, traffic) -> Pick a car
//   cars   - Freeroam > Car selector: car list, specs, paint variants -> Drive
//   pause  - Esc in game: Vehicle (paint, specs, torque curve), Environment, Settings, Controls
// The game hands in what the menu can read and do (`api`); the menu never reaches into the game itself.
import { loadSettings, saveSettings } from './settings.js';

export const VEHICLES = {
  police: { name: 'Police Interceptor', brand: 'Kia', model: 'Seltos Interceptor', cat: 'Police', img: 'ui/car_police.jpg' },
  seltos: { name: 'Kia Seltos', brand: 'Kia', model: 'Seltos', cat: 'SUV', img: 'ui/car_seltos.jpg' },
  mustang: { name: 'Ford Mustang GT500', brand: 'Ford', model: 'Mustang Shelby GT500', cat: 'Sports', img: 'ui/car_mustang.jpg' },
};
const MAPS = {
  flat: { name: 'Flat Grid', img: 'ui/map_flat.jpg', desc: 'An endless prototype floor with AI traffic driving loops in both directions. Room for anything.', stats: [['area', 'Unlimited'], ['road', 'No roads, open ground'], ['surface', '100% asphalt'], ['climate', 'Test site']], traffic: true },
  grid: { name: 'Road Grid', img: 'ui/map_grid.jpg', desc: 'City blocks with signal-controlled junctions, surrounded by villages, farms and forest.', stats: [['area', '0.5 km²'], ['road', '3.2 km of road'], ['surface', '70% asphalt, 30% grass'], ['climate', 'Temperate countryside']] },
  touge: { name: 'Mountain Pass', img: 'ui/map_touge.jpg', desc: 'A narrow touge road snaking up a forested mountainside, guard rails and all.', stats: [['area', '1.8 km²'], ['road', '4.1 km pass'], ['surface', '85% asphalt, 15% grass'], ['climate', 'Alpine forest']] },
  proto: { name: 'Test Track', img: 'ui/map_proto.jpg', desc: 'Proving ground: jumps, speed bumps, washboard, banked bowl, skidpad and low-grip surfaces.', stats: [['area', '0.3 km²'], ['road', 'Open test pad'], ['surface', 'Asphalt, ice, wet, gravel, grass'], ['climate', 'Mountain valley']] },
};
const PAINTS = [
  [null, 'Factory'], [0xe8e8e4, 'Arctic White'], [0x16171b, 'Metallic Black'], [0x8c1c2c, 'Cherry Red'], [0x1d4f91, 'Deep Blue'],
  [0x2f5d3a, 'Forest Green'], [0xd0a020, 'Solar Gold'], [0xff6a13, 'Blaze Orange'], [0x6b6f75, 'Graphite'],
];
const FACTORY = { seltos: '#9aa3a2', mustang: '#c8202a' };
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const I = { // stroke icons (24x24)
  mountain: '<path d="M3 19l6-10 4 6 2-3 6 7z"/>', badge: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  curve: '<path d="M4 20c0-6 4-6 6-10s2-6 8-6"/><circle cx="18" cy="4" r="1.5"/>', flag: '<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>',
  play: '<path d="M7 5l12 7-12 7z"/>', car: '<path d="M3 15l2-6h14l2 6v3h-3m-12 0H3v-3z"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10l2.1 2.1M4.9 19.1l2.1-2.1m10-10l2.1-2.1"/>',
  pad: '<rect x="2" y="7" width="20" height="11" rx="3"/><path d="M6 12.5h4M8 10.5v4M15.5 12h.01M18 14h.01"/>',
  recover: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>', home: '<path d="M3 11l9-7 9 7v9H5v-9"/>',
  area: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9h16M9 4v16"/>', road: '<path d="M8 21l2-18m4 0l2 18M12 6v2m0 4v2m0 4v2"/>',
  surface: '<path d="M3 17h18M5 13l3-4 3 3 3-5 5 6"/>', climate: '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A4 4 0 1 1 17 18z"/>',
  steer: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M3.5 10.5l6 1m5 0l6-1M12 14.5V21"/>', traffic: '<rect x="8" y="2" width="8" height="20" rx="3"/><circle cx="12" cy="7" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="17" r="1.6"/>',
  flame: '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-6 1 1 2 2 2 3 1-2 1-5 1-7z"/>', up: '<path d="M12 20V5m-6 6l6-6 6 6"/>', down: '<path d="M12 4v15m-6-6l6 6 6-6"/>',
  spin: '<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 4v5h-5"/>', burst: '<path d="M12 2v5m0 10v5M2 12h5m10 0h5M5 5l3.5 3.5m7 7L19 19M5 19l3.5-3.5m7-7L19 5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', chev: '<path d="M6 9l6 6 6-6"/>',
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24">${I[n]}</svg>`;
const LOGO = `<div class="nx-logo"><svg viewBox="0 0 32 32"><path d="M6 26V6l20 20V6" fill="none" stroke-width="3.4" stroke-linejoin="miter"/></svg><span>NODENG</span></div>`;

const CSS = `
:root { --nx-or: #ffffff; --nx-or2: #e6e7e9; --nx-ink: #111214; --nx-glass: rgba(22,23,27,.72); --nx-glass2: rgba(30,32,37,.78); --nx-line: rgba(255,255,255,.07); --nx-dim: #9aa0a8; }
#nx { position: fixed; inset: 0; z-index: 20; display: none; color: #f1f2f4; font: 14px/1.4 "Segoe UI", "Noto Sans", ui-sans-serif, system-ui, sans-serif; user-select: none; }
#nx.open { display: block; }
#nx .bg { position: absolute; inset: 0; backdrop-filter: blur(14px) saturate(1.1); background: radial-gradient(120% 90% at 50% 40%, rgba(10,11,13,.25), rgba(4,4,6,.72)); }
#nx.pause .bg { backdrop-filter: blur(10px); background: rgba(6,7,9,.5); }
#nx .screen { position: absolute; inset: 0; padding: clamp(18px, 4.5vh, 48px) clamp(18px, 5vw, 96px); display: flex; flex-direction: column; }
#nx .ic { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; flex: none; }
#nx .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: clamp(14px, 3.4vh, 34px); }
#nx .nx-logo { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 800; letter-spacing: .32em; }
#nx .nx-logo svg { width: 24px; height: 24px; stroke: #fff; }
#nx .nx-logo i { color: var(--nx-or); font-weight: 800; font-style: italic; }
#nx .pill { display: flex; align-items: center; gap: 12px; padding: 5px 16px 5px 5px; border-radius: 30px; background: rgba(60,62,68,.55); border: 1px solid var(--nx-line); backdrop-filter: blur(8px); }
#nx .pill .av { width: 42px; height: 42px; border-radius: 50%; background-size: cover; background-position: 50% 60%; border: 2px solid rgba(255,255,255,.18); }
#nx .pill b { display: block; font-size: 13px; letter-spacing: .03em; } #nx .pill small { color: #c8ccd2; font-size: 12px; }
#nx .tabs { display: flex; align-items: stretch; height: 50px; border-radius: 6px; background: rgba(28,29,33,.7); border: 1px solid var(--nx-line); backdrop-filter: blur(10px); margin-bottom: clamp(16px, 4vh, 56px); }
#nx .tabs .key { display: grid; place-items: center; padding: 0 12px; }
#nx kbd { display: inline-grid; place-items: center; min-width: 26px; height: 26px; padding: 0 7px; border-radius: 5px; border: 1.5px solid rgba(255,255,255,.75); font: 700 12px "Segoe UI", sans-serif; color: #fff; box-sizing: border-box; }
#nx .tabs .tab { flex: 1; display: grid; place-items: center; font-weight: 700; font-size: 17px; letter-spacing: .06em; text-transform: uppercase; cursor: pointer; border-radius: 6px; margin: 0 2px; }
#nx .tabs .tab:hover { background: rgba(255,255,255,.06); }
#nx .tabs .tab.on { color: var(--nx-ink); background: var(--nx-or); }
#nx .tiles { flex: 1; display: grid; grid-template-columns: 2fr 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 14px; min-height: 0; }
#nx .tile { position: relative; overflow: hidden; border-radius: 6px; border: 2px solid rgba(255,255,255,.18); cursor: pointer; background: #222; }
#nx .tile .im { position: absolute; inset: 0; background: center/cover; }
#nx .tile:hover { border-color: var(--nx-or); }
#nx .tile .hd { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; height: 58px; background: linear-gradient(180deg, rgba(10,10,12,.82), rgba(10,10,12,.55)); }
#nx .tile .hd .sq { width: 58px; height: 58px; display: grid; place-items: center; background: var(--nx-or); color: var(--nx-ink); }
#nx .tile .hd .sq .ic { width: 26px; height: 26px; stroke-width: 2.2; }
#nx .tile .hd b { margin-left: clamp(12px, 1.6vw, 24px); font-size: clamp(15px, 1.65vw, 23px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
#nx .tile .ft { position: absolute; left: 0; right: 0; bottom: 0; padding: 26px 22px 14px; background: linear-gradient(0deg, rgba(8,8,10,.85), transparent); color: #d9dce0; font-size: 13px; }
#nx .tile .ft b { color: #fff; }
#nx .crumb { display: flex; align-items: center; height: 56px; border-radius: 4px; background: rgba(28,29,33,.72); border: 1px solid var(--nx-line); backdrop-filter: blur(10px); margin-bottom: 22px; flex: none; }
#nx .crumb .sq { width: 56px; height: 56px; display: grid; place-items: center; background: var(--nx-or); color: var(--nx-ink); border-radius: 4px 0 0 4px; }
#nx .crumb .sq .ic { width: 24px; height: 24px; stroke-width: 2.2; }
#nx .crumb b { margin: 0 22px 0 20px; font-size: 19px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }
#nx .crumb nav { display: flex; align-items: center; gap: 12px; margin-left: 20px; } #nx .crumb span { line-height: 1; color: var(--nx-dim); font-size: 16px; cursor: pointer; } #nx .crumb span.on { color: #fff; } #nx .crumb .sep { width: 14px; height: 14px; color: var(--nx-dim); } #nx .crumb span:hover { color: #fff; }
#nx .glass { background: var(--nx-glass); border: 1px solid var(--nx-line); border-radius: 8px; backdrop-filter: blur(14px); }
#nx .body { flex: 1; display: flex; gap: 18px; min-height: 0; }
#nx .col { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
#nx .scroll { overflow-y: auto; min-height: 0; padding-right: 6px; }
#nx ::-webkit-scrollbar { width: 6px; height: 6px; } #nx ::-webkit-scrollbar-track { background: transparent; }
#nx ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.25); border-radius: 3px; } #nx ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.45); }
#nx ::-webkit-scrollbar-button { display: none; height: 0; }
#nx .pill { cursor: pointer; } #nx .pill:hover { border-color: rgba(255,255,255,.3); }
#nx .ctl { flex: 1; padding: 8px 12px; border-radius: 5px; background: rgba(14,15,17,.75); border: 1px solid var(--nx-line); }
#nx .ctl small { display: block; color: var(--nx-dim); font-size: 11px; margin-bottom: 6px; }
#nx .ctl .seg { display: flex; } #nx .ctl .seg button { flex: 1; }
#nx .ctl input[type=range] { flex: 1; min-width: 0; width: auto; } #nx .ctl .val { width: auto; white-space: nowrap; }
#nx .search { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 14px; border-radius: 6px; background: var(--nx-glass2); border: 1px solid var(--nx-line); color: var(--nx-dim); flex: none; }
#nx .search input { flex: 1; background: none; border: 0; outline: 0; color: #fff; font: inherit; }
#nx .mapcard { position: relative; flex: none; height: 168px; border-radius: 6px; overflow: hidden; border: 2px solid rgba(255,255,255,.12); background: center/cover; cursor: pointer; }
#nx .mapcard.on { border-color: var(--nx-or); }
#nx .mapcard::after { content: ""; position: absolute; inset: 0; background: linear-gradient(0deg, rgba(0,0,0,.55), transparent 55%); }
#nx .mapcard b { position: absolute; left: 14px; bottom: 8px; z-index: 1; font-size: 30px; font-weight: 800; letter-spacing: .02em; text-transform: uppercase; }
#nx .detail { flex: 1; display: flex; overflow: hidden; align-self: flex-start; max-height: 100%; }
#nx .detail .pic { flex: 1.25; min-height: 360px; background: center/cover; }
#nx .detail .info { flex: 1; display: flex; flex-direction: column; padding: 24px 26px; }
#nx h1 { margin: 0; font-size: 34px; font-weight: 800; letter-spacing: .02em; text-transform: uppercase; }
#nx .desc { margin: 10px 0 22px; color: #c5c9cf; font-size: 13.5px; }
#nx .stat { display: flex; align-items: center; gap: 12px; margin: 7px 0; color: #e3e5e8; font-size: 13.5px; } #nx .stat .ic { width: 17px; height: 17px; color: #d0d3d8; }
#nx .rule { height: 1px; background: var(--nx-line); margin: 16px 0; }
#nx .drops { display: flex; gap: 10px; margin-top: auto; }
#nx .drop { flex: 1; padding: 7px 12px; border-radius: 5px; background: rgba(14,15,17,.75); border: 1px solid var(--nx-line); cursor: pointer; position: relative; }
#nx .drop small { display: block; color: var(--nx-dim); font-size: 11px; }
#nx .drop .v { display: flex; align-items: center; gap: 8px; font-size: 16px; } #nx .drop .v .ic { width: 16px; height: 16px; }
#nx .drop .chev { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; }
#nx .drop:hover { border-color: rgba(255,255,255,.25); }
#nx .cta { display: flex; align-items: center; justify-content: center; gap: 10px; height: 42px; margin-top: 14px; border: 0; border-radius: 22px; background: var(--nx-or); color: var(--nx-ink); font: 700 15px "Segoe UI", sans-serif; letter-spacing: .06em; text-transform: uppercase; cursor: pointer; width: 100%; }
#nx .cmain .cta { position: sticky; bottom: 0; margin-top: 4px; }
#nx .cta:hover { background: var(--nx-or2); } #nx .cta .ic { width: 20px; height: 20px; }
#nx .carcard { position: relative; flex: none; height: 92px; border-radius: 6px; overflow: hidden; border: 2px solid rgba(255,255,255,.1); background: rgba(24,25,29,.8); cursor: pointer; }
#nx .carcard .im { position: absolute; right: -10px; top: 0; bottom: 0; width: 72%; background: center/cover; -webkit-mask-image: linear-gradient(90deg, transparent, #000 35%); mask-image: linear-gradient(90deg, transparent, #000 35%); }
#nx .carcard b { position: absolute; left: 12px; top: 10px; font-size: 12.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; z-index: 1; max-width: 60%; }
#nx .carcard small { position: absolute; left: 12px; bottom: 9px; color: var(--nx-dim); font-size: 11px; z-index: 1; }
#nx .carcard.on { border-color: var(--nx-or); }
#nx .selects { display: flex; gap: 10px; flex: none; }
#nx .cmain { flex: 1; display: grid; grid-template-columns: minmax(250px, 1fr) 1.6fr; grid-template-rows: auto 1fr auto auto auto; gap: 14px 18px; padding: 18px; min-width: 0; overflow-y: auto; }
#nx .namebox { display: flex; align-items: center; gap: 16px; padding: 12px 18px; border-radius: 6px; background: rgba(14,15,17,.7); border: 1px solid var(--nx-line); }
#nx .namebox .brand { width: 46px; height: 46px; display: grid; place-items: center; border-right: 1px solid var(--nx-line); padding-right: 16px; font: 900 22px "Segoe UI", sans-serif; color: #e8e8e8; }
#nx .namebox b { display: block; font-size: 22px; font-weight: 800; text-transform: uppercase; letter-spacing: .02em; line-height: 1.1; }
#nx .namebox small { color: var(--nx-dim); font-size: 14px; }
#nx .specs { padding: 14px 18px 16px; border-radius: 6px; background: rgba(14,15,17,.7); border: 1px solid var(--nx-line); align-self: start; }
#nx .specs h4, #nx .ph h4 { margin: 0 0 10px; font-size: 13px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
#nx .bar { margin: 9px 0; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
#nx .bar .l { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 4px; white-space: nowrap; } #nx .bar .l span:last-child { text-transform: none; color: #e6e8eb; }
#nx .bar .t { height: 5px; border-radius: 3px; background: rgba(255,255,255,.12); overflow: hidden; } #nx .bar .t i { display: block; height: 100%; border-radius: 3px; background: #f2f3f5; }
#nx .bigcar { grid-row: 1 / 3; grid-column: 2; width: 100%; height: 100%; object-fit: cover; border-radius: 6px; min-height: 260px; -webkit-mask-image: radial-gradient(120% 95% at 55% 55%, #000 55%, transparent 100%); mask-image: radial-gradient(120% 95% at 55% 55%, #000 55%, transparent 100%); }
#nx .variants-h { grid-column: 1 / -1; font-size: 13px; color: #d6d9dd; }
#nx .variants { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; }
#nx .var { position: relative; height: 70px; border-radius: 6px; overflow: hidden; border: 2px solid rgba(255,255,255,.1); background: #1b1c20; cursor: pointer; }
#nx .var .sw { position: absolute; inset: 0; } #nx .var .sw::after { content: ""; position: absolute; inset: 0; background: linear-gradient(135deg, rgba(255,255,255,.28), transparent 45%, rgba(0,0,0,.35)); }
#nx .var b { position: absolute; left: 0; right: 0; bottom: 0; padding: 5px 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; background: rgba(10,10,12,.72); }
#nx .var.on { border-color: var(--nx-or); } #nx .var.on b { background: var(--nx-or); color: var(--nx-ink); }
#nx .mapmini { position: relative; flex: none; height: 92px; margin-top: auto; border-radius: 6px; overflow: hidden; border: 2px solid rgba(255,255,255,.14); background: center/cover; cursor: pointer; }
#nx .mapmini::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(0,0,0,.7), rgba(0,0,0,.2)); }
#nx .mapmini b { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); font-size: 22px; font-weight: 800; text-transform: uppercase; z-index: 1; max-width: 55%; line-height: 1.05; }
#nx .mapmini .tm { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); z-index: 1; font-size: 13px; text-align: right; line-height: 1.7; }
#nx .mapmini .tm .ic { width: 14px; height: 14px; vertical-align: -2px; margin-right: 5px; }
#nx .hints { display: flex; justify-content: flex-end; gap: 26px; margin-top: 18px; font-size: 13px; color: #e2e4e7; flex: none; }
#nx .hints span { display: flex; align-items: center; gap: 8px; } #nx .hints kbd { height: 24px; border-width: 0; background: rgba(40,42,47,.92); border-radius: 4px; font-size: 11.5px; }
#nx .ptitle { display: flex; align-items: center; gap: 12px; padding: 9px 18px; border-radius: 6px; background: rgba(30,31,35,.78); border: 1px solid var(--nx-line); font-weight: 700; font-size: 15px; letter-spacing: .05em; text-transform: uppercase; }

#nx .rail { width: 212px; flex: none; display: flex; flex-direction: column; padding: 10px 8px; }
#nx .ri { display: flex; align-items: center; gap: 13px; padding: 10px 12px; margin: 2px 0; border-radius: 5px; cursor: pointer; font-weight: 700; font-size: 14px; letter-spacing: .05em; text-transform: uppercase; color: #e6e8eb; }
#nx .ri:hover { background: rgba(255,255,255,.06); } #nx .ri.on { background: var(--nx-or); color: var(--nx-ink); }
#nx .ri .ic { width: 19px; height: 19px; }
#nx .rsep { height: 1px; margin: 10px 10px; background: var(--nx-line); } #nx .grow { flex: 1; }
#nx .pgrid { flex: 1; display: grid; grid-template-columns: minmax(200px, 280px) minmax(0, 1fr); gap: 18px; min-width: 0; min-height: 0; }
#nx .pcol { display: flex; flex-direction: column; gap: 12px; padding: 12px; min-height: 0; } #nx .pcol .drop { flex: none; }
#nx .paints { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
#nx .paints .var { height: 96px; }
#nx .carpanel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: auto 1fr auto; gap: 14px; padding: 18px; min-height: 0; overflow-y: auto; }
#nx .carpanel .hdr { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: baseline; }
#nx .carpanel .hdr h4 { margin: 0; font-size: 17px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
#nx .carpanel .hdr small { font-weight: 700; font-size: 12.5px; letter-spacing: .05em; text-transform: uppercase; }
#nx .carpanel .shot { grid-column: 1 / -1; width: 100%; min-height: 190px; object-fit: cover; -webkit-mask-image: radial-gradient(75% 90% at 50% 52%, #000 50%, transparent 100%); mask-image: radial-gradient(75% 90% at 50% 52%, #000 50%, transparent 100%); }
#nx .ph { padding: 14px 16px; border-radius: 6px; background: rgba(14,15,17,.7); border: 1px solid var(--nx-line); }
#nx .specs2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 0 22px; } #nx .ph { min-width: 0; }
#nx .chart svg { width: 100%; height: 150px; display: block; }
#nx .section { padding: 22px 26px; overflow-y: auto; }
#nx .section h2 { margin: 0 0 4px; font-size: 20px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
#nx .section .sub { margin: 0 0 14px; color: var(--nx-dim); }
#nx .section h3 { margin: 22px 0 6px; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--nx-dim); }
#nx .row { display: flex; align-items: center; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--nx-line); }
#nx .row .lbl { flex: 1; } #nx .row .lbl small { display: block; color: var(--nx-dim); font-size: 12px; }
#nx .seg { display: inline-flex; padding: 3px; gap: 3px; border-radius: 6px; background: rgba(10,11,13,.65); border: 1px solid var(--nx-line); }
#nx .seg button { padding: 6px 13px; border: 0; border-radius: 4px; background: transparent; color: #cfd2d7; font: 600 13px "Segoe UI", sans-serif; cursor: pointer; }
#nx .seg button:hover { background: rgba(255,255,255,.07); color: #fff; } #nx .seg button.on { background: var(--nx-or); color: var(--nx-ink); }
#nx input[type=range] { width: 200px; accent-color: var(--nx-or); } #nx .val { width: 46px; text-align: right; font: 600 13px ui-monospace, monospace; color: #dfe2e6; }
#nx .keys { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 8px 26px; }
#nx .keys div { display: flex; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--nx-line); }
#nx .keys kbd { min-width: 64px; height: 26px; border: 0; background: rgba(50,52,58,.95); font-size: 11.5px; }
#nx .funs { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; margin-top: 14px; }
#nx .fun { display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: 6px; border: 1px solid var(--nx-line); background: rgba(14,15,17,.7); color: #f1f2f4; font: 700 13px "Segoe UI", sans-serif; letter-spacing: .04em; text-transform: uppercase; cursor: pointer; text-align: left; }
#nx .fun:hover { background: #fff; color: var(--nx-ink); } #nx .fun .ic { width: 22px; height: 22px; }
#nx .netstat { display: inline-flex; align-items: center; gap: 9px; margin: 4px 0 14px; padding: 7px 14px; border-radius: 20px; background: rgba(14,15,17,.7); border: 1px solid var(--nx-line); font-weight: 700; font-size: 13px; }
#nx .netstat i { width: 9px; height: 9px; border-radius: 50%; background: #6b6f75; } #nx .netstat.online i { background: #3fdc7c; } #nx .netstat.connecting i { background: #f2c418; } #nx .netstat.failed i { background: #e8452f; }
#nx .txt { width: 220px; padding: 8px 12px; border-radius: 5px; background: rgba(10,11,13,.7); border: 1px solid var(--nx-line); color: #fff; font: 600 14px "Segoe UI", sans-serif; outline: none; } #nx .txt:focus { border-color: rgba(255,255,255,.4); }
#nx .plist { display: grid; gap: 6px; } #nx .plist div { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 5px; background: rgba(14,15,17,.6); border: 1px solid var(--nx-line); font-weight: 600; }
#nx .btnrow { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
#nx .btn { padding: 9px 18px; border: 1px solid rgba(255,255,255,.2); border-radius: 20px; background: rgba(255,255,255,.04); color: #fff; font: 700 13px "Segoe UI", sans-serif; letter-spacing: .05em; text-transform: uppercase; cursor: pointer; }
#nx .btn:hover { border-color: var(--nx-or); } #nx .btn.or { background: var(--nx-or); border-color: var(--nx-or); color: var(--nx-ink); }
@media (max-width: 900px) { #nx .tiles { grid-template-columns: 1fr 1fr; grid-template-rows: none; overflow-y: auto; } #nx .tile { min-height: 150px; grid-column: auto !important; }
  #nx .body, #nx .pgrid { display: flex; flex-direction: column; overflow-y: auto; } #nx .cmain, #nx .carpanel { display: flex; flex-direction: column; } #nx .bigcar { min-height: 200px; } }
`;

export function createMenu(api) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const root = document.createElement('div'); root.id = 'nx'; document.body.appendChild(root);
  let lastTab = null, screen = 'title', tab = 'play', section = 'vehicle', from = 'title', isOpen = false, wasPaused = false, query = '';
  const pick = { map: api.boot.map, vehicle: 'police', paint: null, night: false, traffic: api.boot.traffic, online: false }; // what Drive will launch
  const syncPick = (online = api.net.status() === 'online') => Object.assign(pick, { map: api.boot.map, ...api.current(), traffic: api.boot.traffic, online });
  const specCache = {};
  const specs = (id) => (specCache[id] ||= api.specs(id));
  const ids = Object.keys(VEHICLES);
  const maxOf = (k) => Math.max(...ids.map((id) => specs(id)[k] || 0));

  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
  const hints = (list) => `<div class="hints">${list.map(([k, l]) => `<span><kbd>${k}</kbd>${l}</span>`).join('')}</div>`;
  const pill = () => { const n = api.current(), v = VEHICLES[n.vehicle]; return `<div class="pill"><div class="av" style="background-image:url(${v.img})"></div><div><b>${esc(v.name.toUpperCase())}</b></div></div>`; };
  const header = () => `<div class="top">${LOGO}${pill()}</div>`;
  // breadcrumb trail: Freeroam > Map selector > Car selector; every step is a link, the current one is white
  const crumb = (active) => { const MODE = pick.online ? 'Multiplayer' : 'Freeroam';
    const chev = '<svg class="ic sep" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
    const steps = [['home', MODE], ['maps', 'Map selector'], ['cars', 'Car selector']];
    return `<div class="crumb"><div class="sq">${icon(pick.online ? 'globe' : 'mountain')}</div><nav>${steps.map(([k, l]) => `<span data-go="${k}" class="${active === k ? 'on' : ''}">${l}</span>`).join(chev)}</nav></div>`;
  };

  function seg(opts, cur, on) {
    const el = h('<div class="seg"></div>');
    for (const [v, label] of opts) { const b = h(`<button class="${v === cur ? 'on' : ''}">${label}</button>`); b.onclick = () => { on(v); render(); }; el.appendChild(b); }
    return el;
  }
  function row(label, sub, control) { const r = h(`<div class="row"><div class="lbl">${label}${sub ? `<small>${sub}</small>` : ''}</div></div>`); r.appendChild(control); return r; }
  function slider(min, max, step, value, fmt, on) {
    const w = h('<div style="display:flex;align-items:center;gap:10px;width:100%"></div>');
    const s = h(`<input type="range" min="${min}" max="${max}" step="${step}" value="${value}">`), v = h(`<span class="val">${fmt(value)}</span>`);
    s.oninput = () => { v.textContent = fmt(+s.value); on(+s.value); };
    w.append(s, v); return w;
  }
  const bar = (label, val, frac) => `<div class="bar"><div class="l"><span>${label}</span><span>${val}</span></div><div class="t"><i style="width:${Math.round(Math.max(0.04, Math.min(1, frac)) * 100)}%"></i></div></div>`;
  const specBars = (id) => {
    const s = specs(id), best100 = Math.min(...ids.map((k) => specs(k).zeroTo100 || 99));
    return [bar('Power', Math.round(s.peakHp) + ' hp', s.peakHp / maxOf('peakHp')), bar('Torque', Math.round(s.peakNm) + ' Nm', s.peakNm / maxOf('peakNm')),
      bar('Weight', Math.round(s.kg).toLocaleString() + ' kg', s.kg / maxOf('kg')), bar('0 - 100 km/h', s.zeroTo100 ? s.zeroTo100.toFixed(1) + ' s' : '—', s.zeroTo100 ? best100 / s.zeroTo100 : 0),
      bar('Max speed', Math.round(s.topKmh) + ' km/h', s.topKmh / maxOf('topKmh')), bar('Drivetrain', s.mode, s.mode === 'AWD' ? 1 : 0.6)];
  };
  const torqueChart = (id) => {
    const s = specs(id), c = s.curve, W = 300, H = 150, L = 30, B = 20;
    const maxT = Math.ceil(Math.max(...c.map((p) => Math.max(p.T, p.kw * 1.341))) / 100) * 100, maxR = Math.ceil(s.limiter / 1000) * 1000;
    const X = (r) => L + ((W - L - 6) * r) / maxR, Y = (v) => H - B - ((H - B - 8) * v) / maxT;
    const path = (f) => c.map((p, i) => `${i ? 'L' : 'M'}${X(p.rpm).toFixed(1)} ${Y(Math.max(0, f(p))).toFixed(1)}`).join(' ');
    const area = (f, col) => `<path d="${path(f)} L${X(c[c.length - 1].rpm)} ${Y(0)} L${X(c[0].rpm)} ${Y(0)}Z" fill="${col}" fill-opacity=".22"/><path d="${path(f)}" fill="none" stroke="${col}" stroke-width="2"/>`;
    let grid = '';
    for (let k = 0; k <= 5; k++) { const v = (maxT * k) / 5; grid += `<line x1="${L}" x2="${W - 6}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(255,255,255,.08)"/><text x="${L - 5}" y="${Y(v) + 3}" fill="#9aa0a8" font-size="8" text-anchor="end">${Math.round(v)}</text>`; }
    for (let r = 0; r <= maxR; r += 1000) grid += `<text x="${X(r)}" y="${H - 6}" fill="#9aa0a8" font-size="8" text-anchor="middle">${r / 1000}k</text>`;
    const key = (col, l) => `<span><i style="display:inline-block;width:10px;height:3px;background:${col};vertical-align:middle;margin-right:6px"></i>${l}</span>`;
    return `<svg viewBox="0 0 ${W} ${H}">${grid}${area((p) => p.T, '#ff7a1a')}${area((p) => p.kw * 1.341, '#2fe0b0')}</svg>
      <div style="display:flex;gap:16px;font-size:11px;color:#c9cdd2;margin-top:4px">${key('#ff7a1a', 'Torque Nm')}${key('#2fe0b0', 'Power hp')}</div>`;
  };
  const paintsFor = (id) => (id === 'police' ? [[null, 'Interceptor']] : PAINTS);
  const swatch = (id, c) => (c == null ? (id === 'police' ? 'linear-gradient(135deg,#0b0c0e 55%,#fff 55% 62%,#0b0c0e 62%)' : FACTORY[id]) : hex(c));

  // ------------------------------------------------------------------ screens
  const SCREENS = {
    title(s) {
      const shownTab = lastTab; lastTab = tab;
      const TABS = [['play', 'Play'], ['garage', 'Garage'], ['online', 'Online'], ['settings', 'Settings'], ['controls', 'Controls']];
      s.innerHTML = header() + `<div class="tabs"><div class="key"><kbd>Q</kbd></div>${TABS.map(([k, l]) => `<div class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${l}</div>`).join('')}<div class="key"><kbd>E</kbd></div></div>`;
      s.querySelectorAll('[data-tab]').forEach((el) => (el.onclick = () => { tab = el.dataset.tab; render(); }));
      if (tab === 'play') {
        const cur = api.current();
        const tile = (t, img, ic, title, ft, style = '') => `<div class="tile" data-t="${t}" style="${style}"><div class="im" style="background-image:url(${img})"></div><div class="hd"><div class="sq">${icon(ic)}</div><b>${title}</b></div>${ft ? `<div class="ft">${ft}</div>` : ''}</div>`;
        const tiles = h(`<div class="tiles">
          ${tile('free', 'ui/map_grid.jpg', 'mountain', 'Freeroam', '')}
          ${tile('touge', 'ui/map_touge.jpg', 'curve', 'Touge Run', '')}
          ${tile('track', 'ui/map_proto.jpg', 'flag', 'Test Track', '')}
          ${tile('mp', 'ui/map_flat.jpg', 'globe', 'Multiplayer', api.net.status() === 'online' ? `Online · ${api.net.count() + 1} on this map` : '')}
          ${tile('patrol', 'ui/patrol.jpg', 'badge', 'Police Patrol', '')}
          ${tile('continue', MAPS[api.boot.map].img, 'play', 'Continue', `<b>${esc(MAPS[api.boot.map].name)}</b> · ${esc(VEHICLES[cur.vehicle].name)}`)}
        </div>`);
        tiles.querySelector('[data-t=free]').onclick = () => { syncPick(false); go('maps', 'title'); };
        tiles.querySelector('[data-t=mp]').onclick = () => { syncPick(true); go('maps', 'title'); };
        tiles.querySelector('[data-t=touge]').onclick = () => api.launch({ map: 'touge', vehicle: 'mustang', paint: null, night: false, traffic: api.boot.traffic, online: false });
        tiles.querySelector('[data-t=track]').onclick = () => api.launch({ map: 'proto', vehicle: 'mustang', paint: null, night: false, traffic: api.boot.traffic, online: false });
        tiles.querySelector('[data-t=patrol]').onclick = () => api.launch({ map: 'flat', vehicle: 'police', paint: null, night: true, traffic: Math.max(6, api.boot.traffic), online: false });
        tiles.querySelector('[data-t=continue]').onclick = close;
        s.appendChild(tiles);
      } else if (tab === 'garage') {
        if (shownTab !== 'garage') syncPick(); // entering the garage starts from what you're driving
        s.appendChild(carsBody(true));
      } else {
        const p = h('<div class="glass section" style="flex:1"></div>'); ({ settings: settingsSection, controls: controlsSection, online: onlineSection })[tab](p); s.appendChild(p);
      }
    },
    maps(s) {
      s.innerHTML = header() + crumb('maps');
      const body = h('<div class="body"></div>');
      const left = h(`<div class="col" style="width:min(360px,34vw)"><div class="search">${icon('search')}<input placeholder="Map name" value="${esc(query)}"></div><div class="col scroll"></div></div>`);
      const list = left.querySelector('.scroll');
      const fill = () => {
        list.innerHTML = '';
        for (const [id, m] of Object.entries(MAPS)) {
          if (query && !m.name.toLowerCase().includes(query.toLowerCase())) continue;
          const c = h(`<div class="mapcard ${pick.map === id ? 'on' : ''}" style="background-image:url(${m.img})"><b>${esc(m.name)}</b></div>`);
          c.onclick = () => { pick.map = id; render(); }; list.appendChild(c);
        }
      };
      const inp = left.querySelector('input'); inp.oninput = () => { query = inp.value; fill(); };
      inp.onkeydown = (e) => e.stopPropagation();
      fill();
      const m = MAPS[pick.map];
      const det = h(`<div class="glass detail"><div class="pic" style="background-image:url(${m.img})"></div><div class="info">
        <h1>${esc(m.name)}</h1><div class="rule"></div>
        ${m.stats.map(([k, v]) => `<div class="stat">${icon(k)}<span>${esc(v)}</span></div>`).join('')}
        <div class="rule"></div><div class="drops"></div><button class="cta">Pick a car</button></div></div>`);
      const drops = det.querySelector('.drops');
      const time = h('<div class="ctl"><small>Time</small></div>');
      time.appendChild(seg([[false, 'Day'], [true, 'Night']], pick.night, (v) => { pick.night = v; }));
      drops.appendChild(time);
      if (m.traffic && !pick.online) {
        const tr = h('<div class="ctl"><small>Traffic</small></div>');
        tr.appendChild(slider(0, 12, 1, pick.traffic, (v) => v + ' cars', (v) => { pick.traffic = v; }));
        drops.appendChild(tr);
      }
      det.querySelector('.cta').onclick = () => go('cars');
      body.append(left, det); s.appendChild(body);
    },
    cars(s) {
      s.innerHTML = header() + crumb('cars');
      s.appendChild(carsBody(false));
    },
    pause(s) {
      s.innerHTML = header();
      const body = h('<div class="body"></div>');
      const rail = h('<div class="glass rail"></div>');
      const ITEMS = [['vehicle', 'Vehicle', 'car'], ['env', 'Environment', 'sun'], ['settings', 'Settings', 'gear'], ['online', 'Online', 'globe'], ['fun', 'Fun', 'flame'], ['controls', 'Controls', 'pad']];
      for (const [id, label, ic] of ITEMS) { const it = h(`<div class="ri ${section === id ? 'on' : ''}">${icon(ic)}<span>${label}</span></div>`); it.onclick = () => { section = id; render(); }; rail.appendChild(it); }
      rail.append(h('<div class="grow"></div>'), h('<div class="rsep"></div>'));
      for (const [label, ic, fn] of [['Recover', 'recover', () => { api.recover(); close(); }], ['Main menu', 'home', () => { tab = 'play'; go('title', 'title'); }], ['Resume', 'play', close]]) {
        const it = h(`<div class="ri">${icon(ic)}<span>${label}</span></div>`); it.onclick = fn; rail.appendChild(it);
      }
      body.appendChild(rail);
      if (section === 'vehicle') body.appendChild(vehiclePause());
      else { const p = h('<div class="glass section" style="flex:1"></div>'); ({ env: envSection, settings: settingsSection, controls: controlsSection, fun: funSection, online: onlineSection })[section](p); body.appendChild(p); }
      s.appendChild(body);
    },
  };

  // car selector body (Freeroam > Car selector, and the Garage tab)
  function carsBody(garage) {
    const body = h('<div class="body"></div>');
    const left = h(`<div class="col" style="width:min(250px,26vw)"><div class="col scroll"></div></div>`);
    const list = left.querySelector('.scroll');
    for (const [id, v] of Object.entries(VEHICLES)) {
      const c = h(`<div class="carcard ${pick.vehicle === id ? 'on' : ''}"><div class="im" style="background-image:url(${v.img})"></div><b>${esc(v.model)}</b><small>${esc(v.brand)} · ${esc(v.cat)}</small></div>`);
      c.onclick = () => { if (pick.vehicle !== id) { pick.vehicle = id; pick.paint = null; } render(); }; list.appendChild(c);
    }
    const m = MAPS[pick.map];
    const mini = h(`<div class="mapmini" style="background-image:url(${m.img})"><b>${esc(m.name)}</b><div class="tm"><div>${icon(pick.night ? 'moon' : 'sun')}${pick.night ? 'Night' : 'Day'}</div><div>${icon(pick.online ? 'globe' : 'traffic')}${pick.online ? 'Online' : m.traffic ? pick.traffic + ' cars' : 'No traffic'}</div></div></div>`);
    mini.onclick = () => go('maps', garage ? 'title' : from);
    left.appendChild(mini);
    const v = VEHICLES[pick.vehicle];
    const main = h(`<div class="glass cmain"><div class="namebox"><div class="brand">${esc(v.brand[0])}</div><div><b>${esc(v.model)}</b><small>${esc(v.brand)} · ${esc(v.cat)}</small></div></div>
      <canvas class="bigcar"></canvas>
      <div class="specs"><h4>Specs</h4>${specBars(pick.vehicle).join('')}</div>
      <div class="variants"></div></div>`);
    queueMicrotask(() => api.drawPreview(main.querySelector('canvas.bigcar'), pick.vehicle, pick.paint));
    const vars = main.querySelector('.variants');
    for (const [c, name] of paintsFor(pick.vehicle)) {
      const el = h(`<div class="var ${(pick.paint ?? null) === c ? 'on' : ''}"><div class="sw" style="background:${swatch(pick.vehicle, c)}"></div><b>${esc(name)}</b></div>`);
      el.onclick = () => { pick.paint = c; render(); }; vars.appendChild(el);
    }
    const cta = h(`<button class="cta" style="grid-column:1/-1">${icon('steer')}<span>${pick.online ? 'Drive online' : 'Drive'}</span></button>`);
    cta.onclick = () => api.launch({ ...pick });
    main.appendChild(cta);
    body.append(left, main);
    return body;
  }

  // pause > vehicle: paints on the left, the car with its specs and torque curve on the right
  function vehiclePause() {
    const cur = api.current(), id = cur.vehicle, v = VEHICLES[id];
    const g = h('<div class="pgrid"></div>');
    const col = h(`<div class="glass pcol"><div class="scroll"><div class="paints"></div></div><button class="btn or" style="margin-top:auto">Change vehicle</button></div>`);
    const paints = col.querySelector('.paints');
    for (const [c, name] of paintsFor(id)) {
      const el = h(`<div class="var ${(cur.paint ?? null) === c ? 'on' : ''}"><div class="sw" style="background:${swatch(id, c)}"></div><b>${esc(name)}</b></div>`);
      el.onclick = async () => { if ((cur.paint ?? null) !== c) { await api.swapVehicle(id, c); render(); } }; paints.appendChild(el);
    }
    col.querySelector('.btn').onclick = () => { syncPick(); go('cars', 'pause'); };
    const panel = h(`<div class="glass carpanel"><div class="hdr"><h4>Car</h4><small>${esc(v.brand + ' ' + v.model)}</small></div><canvas class="shot"></canvas>
      <div class="ph"><h4>Specs</h4><div class="specs2">${specBars(id).join('')}</div></div><div class="ph chart"><h4>Torque</h4>${torqueChart(id)}</div></div>`);
    g.append(col, panel);
    queueMicrotask(() => api.drawPreview(panel.querySelector('canvas.shot'), id, cur.paint));
    return g;
  }
  function envSection(p) {
    const m = MAPS[api.boot.map];
    p.innerHTML = `<h2>Environment</h2>`;
    p.appendChild(row('Time of day', null, seg([[false, 'Day'], [true, 'Night']], api.current().night, (n) => api.setNight(n))));
    
    const b = h('<div class="btnrow"></div>');
    const mk = (label, fn, or) => { const x = h(`<button class="btn ${or ? 'or' : ''}">${label}</button>`); x.onclick = fn; b.appendChild(x); };
    mk('Respawn traffic ahead', () => { api.respawnTraffic(); close(); });
    mk('Change map', () => { syncPick(); go('maps', 'pause'); }, true);
    p.appendChild(b);
  }
  // Fun: one-click mischief; each action resumes straight into the game so you see it happen
  // Online: connect to the relay server, your name, who else is on this map
  function onlineSection(p) {
    const N = api.net, st = N.status();
    const label = { offline: 'Offline', connecting: 'Connecting…', online: 'Online', failed: 'Server not reachable' }[st];
    p.innerHTML = `<h2>Online</h2><div class="netstat ${st}"><i></i>${label}${st === 'online' ? ` · ${N.count() + 1} on this map` : ''}</div>`;
    const name = h(`<input class="txt" maxlength="20" value="${esc(N.name())}">`);
    name.onkeydown = (e) => e.stopPropagation();
    name.onchange = () => N.setName(name.value.trim());
    p.appendChild(row('Your name', null, name));
    if (st === 'online') {
      p.insertAdjacentHTML('beforeend', '<h3>Players</h3>');
      const list = [N.name() + ' (you)', ...N.players()];
      p.appendChild(h(`<div class="plist">${list.map((n) => `<div>${icon('car')}<span>${esc(n)}</span></div>`).join('')}</div>`));
    }
    const b = h('<div class="btnrow"></div>');
    const btn = h(`<button class="btn or">${st === 'online' || st === 'connecting' ? 'Disconnect' : 'Connect'}</button>`);
    btn.onclick = () => { st === 'online' || st === 'connecting' ? N.disconnect() : N.connect(); render(); };
    b.appendChild(btn); p.appendChild(b);
  }
  function funSection(p) {
    const st = api.funState();
    p.innerHTML = '<h2>Fun</h2>';
    const grid = h('<div class="funs"></div>');
    const ACTS = [
      ['fire', st.onFire ? 'Put out fire' : 'Set car on fire', 'flame'], ['fireNearest', 'Ignite nearest car', 'flame'],
      ['launch', 'Throw car up', 'up'], ['flip', 'Flip car', 'recover'], ['spin', 'Spin out', 'spin'], ['boost', 'Rocket boost', 'play'],
      ['doors', st.doorsOpen ? 'Close all doors' : 'Open all doors', 'car'], ['blast', 'Blast nearby cars', 'burst'], ['rain', 'Make it rain cars', 'down'],
    ];
    for (const [id, label, ic] of ACTS) { const b = h(`<button class="fun">${icon(ic)}<span>${label}</span></button>`); b.onclick = () => { api.fun(id); close(); }; grid.appendChild(b); }
    p.appendChild(grid);
  }
  function settingsSection(p) {
    const s = loadSettings();
    p.innerHTML = '<h2>Settings</h2><h3>Graphics</h3>';
    p.appendChild(row('Quality', null,
      seg([['auto', 'Auto'], [0, 'High'], [1, 'Medium'], [2, 'Low'], [3, 'Lowest']], s.quality, (v) => { api.setQuality(v); saveSettings({ ...loadSettings(), quality: v }); })));
    p.insertAdjacentHTML('beforeend', '<h3>Audio</h3>');
    p.appendChild(row('Master volume', null, slider(0, 1, 0.05, s.volume, (v) => Math.round(v * 100) + '%', (v) => { api.setVolume(v); saveSettings({ ...loadSettings(), volume: v }); })));
    p.appendChild(row('Mute', null, seg([[false, 'Off'], [true, 'On']], api.muted(), (v) => api.setMuted(v))));
    p.insertAdjacentHTML('beforeend', '<h3>Driving</h3>');
    const a = api.assists();
    p.appendChild(row('Gearbox', null, seg([[true, 'Automatic'], [false, 'Manual']], a.auto, (v) => api.setAssist('auto', v))));
    p.appendChild(row('Stability + traction control', null, seg([[true, 'On'], [false, 'Off']], a.tcs, (v) => api.setAssist('tcs', v))));
    p.appendChild(row('ABS', null, seg([[true, 'On'], [false, 'Off']], a.abs, (v) => api.setAssist('abs', v))));
    p.appendChild(row('Drivetrain', null, seg(a.modes.map((m) => [m, m]), a.mode, (v) => api.setAssist('mode', v))));
    p.insertAdjacentHTML('beforeend', '<h3>Display</h3>');
    p.appendChild(row('Speed units', null, seg([['mph', 'mph'], ['kmh', 'km/h']], api.units(), (v) => { api.setUnits(v); saveSettings({ ...loadSettings(), units: v }); })));
    p.appendChild(row('Camera', null, seg(api.cams().map((c, i) => [i, c]), api.cam(), (v) => api.setCam(v))));
  }
  function controlsSection(p) {
    p.innerHTML = '<h2>Controls</h2>';
    p.appendChild(h(`<div class="keys">${[
      ['W / ↑', 'Throttle'], ['S / ↓', 'Brake · hold when stopped to reverse'], ['A D / ← →', 'Steer'], ['Space', 'Handbrake'],
      ['E / Q', 'Shift up / down'], ['M', 'Automatic / manual gearbox'], ['X', 'Clutch (hold)'], ['V', 'Drivetrain AWD → FWD → RWD'],
      ['T / B', 'Stability control / ABS'], ['C', 'Camera · drag the mouse to orbit'], ['L', 'Headlights'], [', . /', 'Indicators / hazards'],
      ['J', 'Police: emergency lights'], ['Y', 'Police: siren wail → yelp → hi-lo'], ['N', 'Day / night'], ['G', 'Respawn traffic ahead'], ['I', 'Set your car on fire / put it out'], ['Shift + I', 'Set the nearest car on fire'],
      ['R', 'Recover + repair'], ['K', 'AI view'], ['F', 'Debug overlay'], ['O', 'Slow motion'], ['U', 'mph / km/h'], ['Esc', 'Pause menu'],
    ].map(([k, l]) => `<div><kbd>${k}</kbd><span>${l}</span></div>`).join('')}</div>`));
  }

  // ------------------------------------------------------------------ plumbing
  function render() {
    root.className = 'open' + (screen === 'pause' ? ' pause' : '');
    root.innerHTML = '<div class="bg"></div>';
    const s = h('<div class="screen"></div>');
    SCREENS[screen](s);
    s.querySelectorAll('[data-go]').forEach((el) => (el.onclick = () => (el.dataset.go === 'home' ? (from === 'pause' ? go('pause') : go('title')) : go(el.dataset.go))));
    root.appendChild(s);
    const pl = s.querySelector('.pill'); if (pl) pl.onclick = () => { syncPick(); tab = 'garage'; go('title', 'title'); };
    api.attract(screen === 'title');
  }
  function go(to, origin) { if (origin) from = origin; if (to !== 'title') lastTab = null; screen = to; render(); }
  function show(to) {
    lastTab = null;
    if (!isOpen) { isOpen = true; wasPaused = api.paused(); api.setPaused(true); api.duck(true); }
    screen = to; render();
  }
  function close() {
    if (!isOpen) return;
    isOpen = false; root.className = ''; root.innerHTML = '';
    api.attract(false); api.setPaused(wasPaused); api.duck(false);
  }
  function back() {
    if (screen === 'cars') go('maps');
    else if (screen === 'maps') { screen = from === 'pause' ? 'pause' : 'title'; render(); }
    else if (screen === 'pause') close();
  }
  return {
    get isOpen() { return isOpen; },
    title() { tab = 'play'; show('title'); },
    pause(sec) { if (sec) section = sec; from = 'pause'; show('pause'); },
    escape() { if (!isOpen) { from = 'pause'; show('pause'); } else back(); },
    close,
    refresh() { if (isOpen && !root.contains(document.activeElement?.closest?.('input') || null)) render(); },
    key(code) { // keys while the menu is open
      if (screen === 'pause' && code === 'KeyR') { api.recover(); close(); }
      if (screen === 'pause' && code === 'KeyH') { section = 'controls'; render(); }
      if (screen !== 'title') return;
      const T = ['play', 'garage', 'online', 'settings', 'controls'];
      if (code === 'KeyQ') { tab = T[(T.indexOf(tab) + T.length - 1) % T.length]; render(); }
      if (code === 'KeyE') { tab = T[(T.indexOf(tab) + 1) % T.length]; render(); }
    },
  };
}
