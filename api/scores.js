/* ============================================================
   /api/scores — global leaderboard backend (NO external database)
   ------------------------------------------------------------
   Stores scores in a plain JS object attached to Node's `global`,
   so it survives across requests as long as the serverless
   function instance stays warm.

   LIMITATIONS (read this before relying on it):
   - Data resets on every redeploy.
   - Data can reset on a cold start (function "sleeps" after being
     idle, then wakes up with empty memory).
   - Under real traffic Vercel may run more than one instance of
     this function at once — each has its OWN memory, so scores can
     look inconsistent depending on which instance served a request.

   Fine for a low-traffic personal portfolio. For a permanent,
   always-consistent leaderboard later, swap this for real Redis:
   Vercel dashboard -> Storage -> Marketplace -> Upstash for Redis
   (same product that used to be called "Vercel KV", just moved).
   ------------------------------------------------------------
   GET  /api/scores                -> { games: { <id>: {...} } }  (all games, Hall of Fame view)
   GET  /api/scores?game=<id>      -> { game, label, metric, higherIsBetter, unit, entries }
   POST /api/scores  { game, name, value }
        -> { game, entries, best, madeBoard }

   Keep GAMES in sync with the GAMES object in hall-of-fame.js
   on the client — both must agree on ids, direction, and ceilings.
   ============================================================ */

const GAMES = {
  'ttt-wins':         { label: 'Tic-Tac-Toe',        metric: 'Wins',           higherIsBetter: true,  unit: '' },
  'mem-moves':        { label: 'Match the Negative', metric: 'Fewest Moves',   higherIsBetter: false, unit: '' },
  'rx-ms':            { label: 'Shutter Reflex',     metric: 'Fastest',        higherIsBetter: false, unit: ' ms' },
  'tetris-score':     { label: 'Tetris',             metric: 'High Score',     higherIsBetter: true,  unit: '' },
  'sync-gap':         { label: 'Double Exposure',    metric: 'Best Sync',      higherIsBetter: false, unit: ' ms' },
  'snake-score':      { label: 'Film Roll',          metric: 'High Score',     higherIsBetter: true,  unit: '' },
  'flashback-streak': { label: 'Flashback',          metric: 'Longest Streak', higherIsBetter: true,  unit: '' },
  'whack-hits':       { label: 'Whack-a-Neg',        metric: 'Top Hits',       higherIsBetter: true,  unit: '' },
  'odd-round':        { label: 'Odd One Out',        metric: 'Highest Round', higherIsBetter: true,  unit: '' },
  'exposure-streak':  { label: 'Perfect Exposure',   metric: 'Best Streak',    higherIsBetter: true,  unit: '' }
};

const MAX_ENTRIES = 10;   // how many rows the Hall of Fame shows per game
const NAME_MAX_LEN = 16;

// Rough sanity ceilings so a stray DevTools POST can't wreck the board.
// This is NOT real anti-cheat — just a guardrail against obviously fake numbers.
const VALUE_CEILING = {
  'ttt-wins': 999,
  'mem-moves': 200,
  'rx-ms': 5000,
  'tetris-score': 999999,
  'sync-gap': 5000,
  'snake-score': 99999,
  'flashback-streak': 200,
  'whack-hits': 999,
  'odd-round': 200,
  'exposure-streak': 999
};

// One score per (game, name) is kept — the object is naturally bounded in
// size and needs no separate trimming logic like a raw log would.
if (!global.__hofLeaderboards) {
  global.__hofLeaderboards = {}; // { [game]: { [playerName]: score } }
}
const store = global.__hofLeaderboards;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Anonymous';
  const cleaned = raw.replace(/[<>]/g, '').trim().slice(0, NAME_MAX_LEN);
  return cleaned.length ? cleaned : 'Anonymous';
}

function getLeaderboard(game) {
  const cfg = GAMES[game];
  if (!cfg) return null;
  const table = store[game] || {};
  const entries = Object.entries(table).map(([name, score]) => ({ name, score }));
  entries.sort((a, b) => (cfg.higherIsBetter ? b.score - a.score : a.score - b.score));
  return entries.slice(0, MAX_ENTRIES);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const { game } = req.query;

      if (game) {
        const cfg = GAMES[game];
        if (!cfg) return res.status(404).json({ error: 'unknown game' });
        const entries = getLeaderboard(game);
        return res.status(200).json({ game, ...cfg, entries });
      }

      // no game specified -> return every leaderboard at once (Hall of Fame)
      const ids = Object.keys(GAMES);
      const result = {};
      ids.forEach((id) => {
        result[id] = { id, ...GAMES[id], entries: getLeaderboard(id) };
      });
      return res.status(200).json({ games: result });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const { game, name, value } = body;
      const cfg = GAMES[game];
      if (!cfg) return res.status(404).json({ error: 'unknown game' });

      const num = Number(value);
      if (!Number.isFinite(num)) return res.status(400).json({ error: 'invalid value' });
      const ceiling = VALUE_CEILING[game] ?? Number.MAX_SAFE_INTEGER;
      if (num < 0 || num > ceiling) return res.status(400).json({ error: 'value out of range' });

      const safeName = sanitizeName(name);
      const table = store[game] || (store[game] = {});
      const existing = table[safeName];
      const better = existing === undefined || (cfg.higherIsBetter ? num > existing : num < existing);
      if (better) table[safeName] = num;

      const entries = getLeaderboard(game);
      const best = entries[0] || null;
      const madeBoard = entries.some((e) => e.name === safeName && e.score === num);
      return res.status(200).json({ game, entries, best, madeBoard });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
}
