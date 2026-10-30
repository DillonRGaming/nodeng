// Multiplayer client: one WebSocket to the relay server (server/server.js, reached through the ngrok
// tunnel). Says hello (name, car, map), then streams this car's state; the handlers get other players
// joining, leaving and their states. Everything else (physics, damage) stays local to each player.
export const DEFAULT_SERVER = 'wss://willis-transported-placidly.ngrok-free.dev';

export class Net {
  constructor(handlers) { this.h = handlers; this.ws = null; this.status = 'offline'; this.id = null; this.count = 0; this.hello = null; }
  connect(url, hello) {
    this.close();
    this.hello = hello; this.status = 'connecting'; this.h.status?.();
    let ws;
    try { ws = this.ws = new WebSocket(url); } catch { this.status = 'failed'; this.h.status?.(); return; }
    ws.onopen = () => { this.status = 'online'; this.send(this.hello()); this.h.status?.(); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'welcome') { this.id = m.id; this.h.reset?.(); for (const p of m.players) this.h.join(p); this.count = m.players.length; this.h.status?.(); }
      else if (m.t === 'join') { this.count++; this.h.join(m); this.h.status?.(); }
      else if (m.t === 'leave') { this.count = Math.max(0, this.count - 1); this.h.leave(m.id); this.h.status?.(); }
      else if (m.t === 'state') this.h.state(m);
      else if (m.t === 'fx') this.h.fx?.(m);
    };
    ws.onclose = () => { if (this.ws !== ws) return; this.ws = null; this.status = this.status === 'connecting' ? 'failed' : 'offline'; this.count = 0; this.h.reset?.(); this.h.status?.(); };
    ws.onerror = () => {};
  }
  // re-introduce ourselves (changed car / paint): the others rebuild our car
  rehello() { if (this.status === 'online') this.send(this.hello()); }
  send(m) { if (this.ws?.readyState === 1 && this.ws.bufferedAmount < 128 * 1024) this.ws.send(JSON.stringify(m)); }
  close() { const ws = this.ws; this.ws = null; if (ws) ws.close(); this.status = 'offline'; this.count = 0; this.h.reset?.(); this.h.status?.(); }
}
