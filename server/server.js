// NodeNG multiplayer relay. Every player simulates their own car; this just passes messages between the
// players on the same map: who's here (join / leave) and each car's state ~20 times a second.
// Run:  cd server && npm install && npm start      (listens on PORT, default 8000 - what the ngrok tunnel forwards)
import { WebSocketServer } from 'ws';
import http from 'node:http';

const PORT = +process.env.PORT || 8000;
const players = new Map(); // ws -> { id, name, vehicle, paint, map }
let nextId = 1;

// plain HTTP answers too, so opening the URL in a browser shows it's alive
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end(`NodeNG server · ${players.size} online\n`); });
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

const info = (p) => ({ id: p.id, name: p.name, vehicle: p.vehicle, paint: p.paint });
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const room = (map, except) => [...players].filter(([ws, p]) => p.map === map && ws !== except);

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const me = players.get(ws);
    if (m.t === 'hello') {
      if (me) { for (const [o] of room(me.map, ws)) send(o, { t: 'leave', id: me.id }); } // re-hello: changed map / car
      const p = { id: me?.id ?? nextId++, name: String(m.name || 'Driver').slice(0, 20), vehicle: m.vehicle, paint: m.paint ?? null, map: String(m.map) };
      players.set(ws, p);
      send(ws, { t: 'welcome', id: p.id, players: room(p.map, ws).map(([, o]) => info(o)) });
      for (const [o] of room(p.map, ws)) send(o, { t: 'join', ...info(p) });
      console.log(`${p.name} (#${p.id}) on ${p.map} · ${players.size} online`);
    } else if (me && (m.t === 'state' || m.t === 'fx')) {
      m.id = me.id; const s = JSON.stringify(m);
      for (const [o] of room(me.map, ws)) if (o.readyState === 1 && o.bufferedAmount < 256 * 1024) o.send(s);
    }
  });
  ws.on('close', () => {
    const p = players.get(ws); players.delete(ws);
    if (p) { for (const [o] of room(p.map)) send(o, { t: 'leave', id: p.id }); console.log(`${p.name} left · ${players.size} online`); }
  });
});
server.listen(PORT, () => console.log(`NodeNG server on :${PORT}`));
