# NodeNG

A browser car physics sandbox built with three.js: soft-body crash deformation, 300 Hz vehicle physics,
AI traffic that pulls over for police sirens, fluids, fires and a full in-game menu.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Controls

Press **Esc** in game for the menu (the Controls tab lists every key).

## Multiplayer

The game is a static site (GitHub Pages); multiplayer goes through a small relay server you host:

```bash
cd server && npm install && npm start
```

It listens on port 8000. Expose it with the ngrok tunnel (`ngrok start web`, domain
`willis-transported-placidly.ngrok-free.dev`), which is the game's default server. In game:
**Esc → Online → Connect**.
