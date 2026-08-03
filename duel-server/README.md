# ⚔️ Poké-Gacha Duel Server

Adds real-time PvP duels to the game. A small Node server relays messages between
two browsers; the game itself runs all battle logic identically on both sides, so
the server never computes damage.

## Run locally

```bash
cd ~/poke-gacha-battle/duel-server
npm install
npm start          # or: node server.js
```

Then open **http://localhost:3001** in two tabs (or two browsers) — the game now
has a **DUEL** button at the bottom-left. Log in as two different accounts, challenge,
accept, and play.

Port defaults to **3001** (the Roblox bridge owns 3000, so it's left alone).
Override with `PORT=4000 npm start`.

## Play across networks (different devices)

The server has no battle logic, so it must be reachable by both players. Two options:

### Fast: Cloudflare quick tunnel (no account, ephemeral)

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3001
```

Both players open the printed `https://<random>.trycloudflare.com` URL. WebSocket
is same-origin so it "just works". The URL changes every run — fine for a session.

### Proper: host on Railway

1. Put the `poke-gacha-battle` folder in a git repo and push to GitHub.
2. In the Railway dashboard create a new project → Deploy from repo → choose the repo.
3. Set the start command to `node duel-server/server.js` (Railway's `nixpacks`
   detects `package.json` in the repo root — if not, set the root directory to
   `duel-server`). Port comes from `$PORT`, which Railway injects automatically.
4. Railway gives a stable public `https://…up.railway.app` URL — share that.

## Notes / known limits

- **Pending challenges are in-memory** — if the server restarts, undelivered
  challenges are lost. Fine for v1.
- **Accounts are per-device.** Each browser keeps its own `localStorage` save keyed
  by username. The server only knows usernames + the team specs (names & HP) you
  send when a duel starts — no save data ever leaves the device.
- **Same username can't be online twice** — the second login gets an error.

## Message protocol (for reference)

Client → Server: `hello`, `challenge`, `challenge_resp`, `team`, `action`, `leave`
Server → Client: `status`, `challenge`, `challenge_sent`, `challenge_resp`, `match`,
`opp_team`, `round` (carries both actions + a per-round RNG seed), `end`, `error`
