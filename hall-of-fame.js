/* ============================================================
   Hall of Fame — global leaderboard powered by /api/scores
   ------------------------------------------------------------
   HOW TO INSTALL
   1. Delete the OLD in-memory leaderboard block from the page's
      inline <script> — just this one IIFE:

        const TopScore = (function(){
          ... (the whole block that ends with) ...
          return { submit, refresh, getCached: ... };
        })();

      Leave the "load initial top scores into arcade cards" list
      of `TopScore.refresh('topscore:...', [...])` calls RIGHT
      AFTER it exactly as-is — they still work, now against the
      real API.

   2. Add this file near the end of <body>, after the big inline
      <script> block that defines all the games:

        <script src="hall-of-fame.js"></script>

   Nothing else needs to change. Every game already calls
   TopScore.submit(key, value, higherIsBetter, displayEls, formatter)
   with the exact same signature this file expects.
   ============================================================ */
(function () {
  'use strict';

  // Same-origin by default (site + API both on Vercel).
  // If the site is hosted elsewhere (e.g. GitHub Pages) and only the
  // API lives on Vercel, point this at that deployment instead, e.g.:
  // const API_BASE = 'https://your-project.vercel.app';
  const API_BASE = '';

  // Keep this in sync with GAMES in api/scores.js
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
  const GAME_ORDER = Object.keys(GAMES);

  /* ---------------- styles for the Hall of Fame grid ---------------- */
  const style = document.createElement('style');
  style.textContent = `
    #hall-of-fame .hof-intro{font-family:var(--body);font-size:14.5px;color:#3a3a35;max-width:60ch;margin-bottom:24px;}
    body[data-theme="dark"] #hall-of-fame .hof-intro{color:var(--footer-fg-dim);}
    .hof-name-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:28px;
      font-family:var(--mono);font-size:12px;color:var(--grey-frame);text-transform:uppercase;letter-spacing:0.05em;}
    .hof-name-row b{color:var(--safelight);font-family:var(--display);font-size:16px;letter-spacing:0;text-transform:none;}
    .hof-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--line);border:1px solid var(--line);}
    @media (max-width:760px){.hof-grid{grid-template-columns:1fr;}}
    .hof-block{background:var(--paper);padding:28px;}
    .hof-block h3{font-family:var(--display);font-size:24px;text-transform:uppercase;letter-spacing:0.3px;margin-bottom:2px;}
    .hof-block .hof-metric{font-family:var(--mono);font-size:10px;color:var(--safelight);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:14px;display:block;}
    .hof-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px dashed var(--line);font-family:var(--body);font-size:13.5px;}
    .hof-row:first-of-type{border-top:none;}
    .hof-rank{font-family:var(--mono);font-size:11px;color:var(--grey-frame);width:20px;flex-shrink:0;}
    .hof-row:nth-child(2) .hof-rank{color:var(--kodak);}
    .hof-pname{flex:1;color:var(--ink);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .hof-pscore{font-family:var(--mono);font-size:12px;color:var(--ink);}
    .hof-empty{font-family:var(--mono);font-size:11.5px;color:var(--grey-frame);padding:6px 0;}
  `;
  document.head.appendChild(style);

  /* ---------------- player name storage (per browser) ---------------- */
  function getName() {
    try { return localStorage.getItem('jp_player_name') || ''; } catch (e) { return ''; }
  }
  function setName(name) {
    try { localStorage.setItem('jp_player_name', name); } catch (e) {}
  }

  /* ---------------- name-entry modal (reuses existing .namemodal-* CSS) ---------------- */
  const modalHTML = `
    <div class="namemodal-overlay" id="nameModalOverlay">
      <div class="namemodal-panel">
        <h3>Name Your Score</h3>
        <div class="namemodal-sub">This goes on the Hall of Fame — visible to every visitor</div>
        <input type="text" id="nameModalInput" maxlength="16" placeholder="Your name or initials" autocomplete="off">
        <div class="namemodal-actions">
          <button class="timer-btn" id="nameModalSkip">Skip</button>
          <button class="timer-btn primary" id="nameModalSave">Save</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  const nameOverlay = document.getElementById('nameModalOverlay');
  const nameInput = document.getElementById('nameModalInput');
  const nameSaveBtn = document.getElementById('nameModalSave');
  const nameSkipBtn = document.getElementById('nameModalSkip');

  // holds the score submission that triggered the modal, if any
  let pendingSubmission = null;

  function openNameModal() {
    nameInput.value = getName();
    nameOverlay.classList.add('on');
    setTimeout(() => nameInput.focus(), 30);
  }
  function closeNameModal() {
    nameOverlay.classList.remove('on');
  }

  nameSaveBtn.addEventListener('click', () => {
    const val = nameInput.value.trim().slice(0, 16);
    setName(val || 'Anonymous');
    refreshNameLabel();
    closeNameModal();
    if (pendingSubmission) { postScore(pendingSubmission); pendingSubmission = null; }
  });
  nameSkipBtn.addEventListener('click', () => {
    setName('Anonymous');
    refreshNameLabel();
    closeNameModal();
    if (pendingSubmission) { postScore(pendingSubmission); pendingSubmission = null; }
  });
  nameOverlay.addEventListener('click', (e) => {
    if (e.target === nameOverlay) { closeNameModal(); pendingSubmission = null; }
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameSaveBtn.click(); });

  /* ---------------- Hall of Fame section (injected after #arcade) ---------------- */
  function buildHofHTML() {
    const blocks = GAME_ORDER.map((id) => {
      const g = GAMES[id];
      return `
        <div class="hof-block" data-game="${id}">
          <h3>${g.label}</h3>
          <span class="hof-metric">${g.metric}</span>
          <div class="hof-list" id="hofList-${id}"><div class="hof-empty">Loading…</div></div>
        </div>`;
    }).join('');

    return `
      <section class="section wrap reveal" id="hall-of-fame">
        <div class="section-label"><span class="num">HOF</span><h2>Hall of Fame</h2></div>
        <p class="hof-intro">Global top scores across every visitor — pulled live from the Arcade above. Play any game for a shot at the board.</p>
        <div class="hof-name-row">
          <span>PLAYING AS <b id="hofCurrentName">Anonymous</b></span>
          <button class="timer-btn" id="hofChangeName">Change Name</button>
        </div>
        <div class="hof-grid">${blocks}</div>
      </section>`;
  }

  const arcadeSection = document.getElementById('arcade');
  if (arcadeSection) {
    arcadeSection.insertAdjacentHTML('afterend', buildHofHTML());
  } else {
    document.querySelector('main')?.insertAdjacentHTML('beforeend', buildHofHTML());
  }
  // Note: this section is inserted with a "HOF" badge instead of a number so
  // it never collides with the numbered sections (Resume, Journey, ...) that
  // come after it in the HTML. Renumber manually if you want it sequential.

  const hofCurrentName = document.getElementById('hofCurrentName');
  const hofChangeNameBtn = document.getElementById('hofChangeName');
  function refreshNameLabel() {
    hofCurrentName.textContent = getName() || 'Anonymous';
  }
  refreshNameLabel();
  hofChangeNameBtn.addEventListener('click', () => {
    pendingSubmission = null;
    openNameModal();
  });

  // nav link
  const navlinks = document.querySelector('.navlinks');
  if (navlinks) {
    const a = document.createElement('a');
    a.href = '#hall-of-fame';
    a.textContent = 'Hall of Fame';
    navlinks.appendChild(a);
  }

  /* ---------------- rendering ---------------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderLeaderboard(id, entries) {
    const el = document.getElementById(`hofList-${id}`);
    if (!el) return;
    if (!entries || !entries.length) {
      el.innerHTML = '<div class="hof-empty">No scores yet — be the first.</div>';
      return;
    }
    const unit = GAMES[id] ? GAMES[id].unit || '' : '';
    el.innerHTML = entries.map((e, i) => `
      <div class="hof-row">
        <span class="hof-rank">${i + 1}.</span>
        <span class="hof-pname">${escapeHtml(e.name)}</span>
        <span class="hof-pscore">${e.score}${unit}</span>
      </div>`).join('');
  }

  async function loadHallOfFame() {
    try {
      const res = await fetch(`${API_BASE}/api/scores`);
      const data = await res.json();
      GAME_ORDER.forEach((id) => {
        const g = data.games && data.games[id];
        renderLeaderboard(id, g ? g.entries : []);
      });
    } catch (e) {
      GAME_ORDER.forEach((id) => renderLeaderboard(id, []));
    }
  }
  loadHallOfFame();

  /* ---------------- TopScore: same public API, now backed by the server ---------------- */
  async function postScore({ game, value, displayEls, formatter }) {
    const name = getName() || 'Anonymous';
    try {
      const res = await fetch(`${API_BASE}/api/scores?game=${game}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, name, value })
      });
      const data = await res.json();
      const best = data.best ? data.best.score : value;
      const text = formatter ? formatter(best) : String(best);
      (displayEls || []).forEach((el) => { if (el) el.textContent = text; });
      if (data.madeBoard && typeof Achievements !== 'undefined') Achievements.unlock('highScore');
      renderLeaderboard(game, data.entries);
    } catch (e) {
      const text = formatter ? formatter(value) : String(value);
      (displayEls || []).forEach((el) => { if (el) el.textContent = text; });
    }
  }

  window.TopScore = {
    // identical signature to the old in-memory version — no game code changes needed
    submit(key, value, higherIsBetter, displayEls, formatter) {
      const game = key.replace('topscore:', '');
      if (!GAMES[game]) return;
      const payload = { game, value, displayEls, formatter };
      if (!getName()) {
        pendingSubmission = payload;
        openNameModal();
      } else {
        postScore(payload);
      }
    },
    refresh(key, displayEls, formatter) {
      const game = key.replace('topscore:', '');
      if (!GAMES[game]) return;
      fetch(`${API_BASE}/api/scores?game=${game}`)
        .then((r) => r.json())
        .then((data) => {
          const best = data.entries && data.entries[0] ? data.entries[0].score : null;
          const text = best == null ? '—' : (formatter ? formatter(best) : String(best));
          (displayEls || []).forEach((el) => { if (el) el.textContent = text; });
        })
        .catch(() => {
          (displayEls || []).forEach((el) => { if (el) el.textContent = '—'; });
        });
    }
  };
})();
