// Persistent sandbox settings (vehicle, map, traffic, graphics, audio, units), kept in localStorage.
// Things that change what gets built (map, vehicle, traffic) apply on the next load; the rest live.
const KEY = 'carsim.settings';
export const DEFAULTS = { map: 'flat', vehicle: 'police', paint: null, traffic: 6, quality: 'auto', volume: 0.8, units: 'mph', night: false };
export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window: settings just don't stick */ }
}
