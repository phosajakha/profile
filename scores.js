import { kv } from '@vercel/kv';

/* ============================================================
   /api/scores — global leaderboard backend
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
  'odd-round':        { label: 'Odd One Out',        metric: 'Highest Round',  higherIsBetter: true,  unit: '' },
  'exposure-streak':  { label: 'Perfect Exposure',   metric: 'Best Streak',    higherIsBetter: true,  unit: '' }
};

const MAX_ENTRIES = 10;   // how many rows the Hall of Fame shows per game
const KEEP_BUFFER = 100;  // how many raw entries we let a sorted set grow to before trimming
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

/**
 * Members are stored as "name#timestamp" so the same player can appear
 * more than once over time. We fetch a generous slice, then dedupe down
 * to the player's single best entry, and trim to MAX_ENTRIES.
 */
async function getLeaderboard(game) {
  const cfg = GAMES[game];
  if (!cfg) return null;
  const key = `leaderboard:${game}`;

  const raw = cfg.higherIsBetter
    ? await kv.zrange(key, 0, KEEP_BUFFER - 1, { rev: true, withScores: true })
    : await kv.zrange(key, 0, KEEP_BUFFER - 1, { withScores: true });

  const seen = new Set();
  const entries = [];
  for (let i = 0; i < raw.length; i += 2) {
    const member = String(raw[i]);
    const score = Number(raw[i + 1]);
    const name = member.split('#')[0];
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, score });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

async function trimLeaderboard(game) {
  const cfg = GAMES[game];
  const key = `leaderboard:${game}`;
  const count = await kv.zcard(key);
  if (count <= KEEP_BUFFER) return;

  if (cfg.higherIsBetter) {
    // ascending rank 0 = lowest score -> drop the lowest ranks
    await kv.zremrangebyrank(key, 0, count - KEEP_BUFFER - 1);
  } else {
    // ascending rank 0 = best (lowest) score -> drop everything past the buffer
    await kv.zremrangebyrank(key, KEEP_BUFFER, -1);
  }
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
        const entries = await getLeaderboard(game);
        return res.status(200).json({ game, ...cfg, entries });
      }

      // no game specified -> return every leaderboard at once (Hall of Fame)
      const ids = Object.keys(GAMES);
      const all = await Promise.all(
        ids.map(async (id) => ({ id, ...GAMES[id], entries: await getLeaderboard(id) }))
      );
      const result = {};
      all.forEach((g) => { result[g.id] = g; });
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
      const key = `leaderboard:${game}`;
      const member = `${safeName}#${Date.now()}`;
      await kv.zadd(key, { score: num, member });
      await trimLeaderboard(game);

      const entries = await getLeaderboard(game);
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
