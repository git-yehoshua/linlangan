/* The Impostor Game - vanilla JS, no frameworks.
   Single network call at startup (words.json); everything else is in memory.
   UI: 5 screens (Setup, Card, Play, Vote, Result) per UI_PROMPT.md.
   Card reveal: swipe-up sheet adapted from reveal-demo.html (peek, don't keep).
   State machine: setup > card > play > vote > result > (next round | final). */
(function () {
  "use strict";

  var CLUE_SECONDS = 15;

  // Card colors cycle by PLAYER ORDER, never by role (privacy rule).
  var CARD_COLORS = ["#88F5F5", "#F4B3D4", "#F6EE8A", "#CDBDF7", "#A9F2B8", "#FFC8A2"];

  var SKIP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M6 5l9 7-9 7V5zm10 0h2v14h-2V5z"/></svg>';

  var root = document.getElementById("app");

  // ---- Session state (in memory; usedIds also mirrored to localStorage) ----
  var S = {
    phase: "setup",
    allWords: [],
    config: { playerCount: 5, mode: "pair", blank: false, difficulty: "ALL", timer: true },
    setupNames: [],
    players: [],        // { name, role, alive, score }
    colors: [],         // card color per player-order index
    word: null,
    usedIds: [],
    cardIndex: 0,
    clueRound: 1,
    maxRounds: 2,
    starter: 0,
    timerLeft: CLUE_SECONDS,
    timerId: null,
    selected: -1,       // vote pick (player index)
    revoted: false,
    guessFor: -1,
    pendingBonus: null,
    result: null
  };

  // ---------- helpers ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function buzz(ms) {
    try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }

  function loadUsed() {
    try {
      var raw = localStorage.getItem("impostorUsedIds");
      if (raw) S.usedIds = JSON.parse(raw) || [];
    } catch (e) { S.usedIds = []; }
  }

  function saveUsed() {
    try { localStorage.setItem("impostorUsedIds", JSON.stringify(S.usedIds)); } catch (e) {}
  }

  function stopTimer() {
    if (S.timerId) { clearInterval(S.timerId); S.timerId = null; }
  }

  function playerLabel(i) {
    return (S.players[i] && S.players[i].name) || ("Player " + (i + 1));
  }

  function quitToSetup() {
    if (S.phase === "setup") return;
    if (window.confirm("Quit this round and go back to setup?")) {
      stopTimer();
      S.phase = "setup";
      render();
    }
  }

  // ---------- role counts (PRD section 3) ----------
  // 4-7 players: 1 impostor. 8-12: 2. Blank (if enabled, 6+ players) replaces one civilian.
  function roleCounts(n, blankOn) {
    var impostors = n >= 8 ? 2 : 1;
    var blank = (blankOn && n >= 6) ? 1 : 0;
    return { impostors: impostors, blank: blank, civilians: n - impostors - blank };
  }

  function assignRoles(n, blankOn) {
    var c = roleCounts(n, blankOn);
    var roles = [];
    var i;
    for (i = 0; i < c.civilians; i++) roles.push("civilian");
    for (i = 0; i < c.impostors; i++) roles.push("impostor");
    for (i = 0; i < c.blank; i++) roles.push("blank");
    return shuffle(roles);
  }

  // ---------- word picker: mode + difficulty filter, no repeats ----------
  function pickWord() {
    var cfg = S.config;
    var pool = S.allWords.filter(function (w) {
      if (w.mode !== cfg.mode) return false;
      if (cfg.difficulty !== "ALL" && w.difficulty !== cfg.difficulty) return false;
      return S.usedIds.indexOf(w.id) === -1;
    });
    if (pool.length === 0) {
      // All matching words used: reset the used pool for this filter so play can continue.
      var keep = S.allWords.filter(function (w) {
        return !(w.mode === cfg.mode && (cfg.difficulty === "ALL" || w.difficulty === cfg.difficulty));
      }).map(function (w) { return w.id; });
      S.usedIds = keep;
      saveUsed();
      pool = S.allWords.filter(function (w) {
        if (w.mode !== cfg.mode) return false;
        if (cfg.difficulty !== "ALL" && w.difficulty !== cfg.difficulty) return false;
        return true;
      });
    }
    if (pool.length === 0) return null;
    var w = pool[Math.floor(Math.random() * pool.length)];
    S.usedIds.push(w.id);
    saveUsed();
    return w;
  }

  // Pill content per role. Pair-mode impostor sees an identical-looking word;
  // single-mode impostor gets the red alert + category; blank gets "???".
  function pillFor(role, word) {
    if (role === "blank") return { cls: "", text: "???" };
    if (role === "civilian") return { cls: "", text: word.civilian };
    if (S.config.mode === "single") {
      return { cls: "alert", text: "You are the impostor!", sub: word.impostor.replace(/^Hint:\s*/, "") };
    }
    return { cls: "", text: word.impostor };
  }

  // ---------- round setup ----------
  function startRound() {
    stopTimer();
    var cfg = S.config;
    var n = cfg.playerCount;
    var word = pickWord();
    if (!word) {
      root.innerHTML = '<div class="stage stage-pad" style="--card:#FFFFFF">' +
        '<div class="face"><h2 class="screen-title">No words</h2>' +
        "<p>Nothing matches this mode and difficulty. Try another filter.</p>" +
        '<button class="btn" id="b-back">' + SKIP_ICON + "Back to setup</button></div></div>";
      document.getElementById("b-back").onclick = function () { S.phase = "setup"; render(); };
      return;
    }
    var roles = assignRoles(n, cfg.blank);
    if (S.players.length !== n) {
      S.players = [];
      for (var i = 0; i < n; i++) S.players.push({ name: "", role: roles[i], alive: true, score: 0 });
    } else {
      for (var k = 0; k < n; k++) { S.players[k].role = roles[k]; S.players[k].alive = true; }
    }
    for (var j = 0; j < n; j++) S.players[j].name = S.setupNames[j] || "";
    S.colors = [];
    for (var c = 0; c < n; c++) S.colors.push(CARD_COLORS[c % CARD_COLORS.length]);
    S.word = word;
    S.cardIndex = 0;
    S.clueRound = 1;
    S.maxRounds = n >= 8 ? 3 : 2;
    S.starter = Math.floor(Math.random() * n);
    S.timerLeft = CLUE_SECONDS;
    S.selected = -1;
    S.revoted = false;
    S.guessFor = -1;
    S.pendingBonus = null;
    S.result = null;
    S.phase = "card";
    render();
  }

  // ---------- win check (PRD FR6) ----------
  function checkWin() {
    var alive = S.players.filter(function (p) { return p.alive; });
    var aliveImp = alive.filter(function (p) { return p.role === "impostor"; }).length;
    var aliveCiv = alive.filter(function (p) { return p.role === "civilian"; }).length;
    var totalImp = S.players.filter(function (p) { return p.role === "impostor"; }).length;
    var elimImp = S.players.filter(function (p) { return p.role === "impostor" && !p.alive; }).length;
    if (elimImp >= totalImp) return { winner: "civilians", reason: "All impostors were caught, and no correct guess was made." };
    if (aliveImp >= aliveCiv && aliveCiv > 0) {
      return { winner: "impostors", reason: "Impostors now equal or outnumber the remaining civilians." };
    }
    return null;
  }

  // ---------- scoring (PRD FR7; blank correct guess = +3) ----------
  function applyScoring(outcome, opts) {
    opts = opts || {};
    if (outcome.winner === "civilians") {
      S.players.forEach(function (p) {
        if (p.role === "civilian" && p.alive) p.score += 1;
      });
    } else if (outcome.winner === "impostors") {
      if (opts.guessCorrect && opts.guessBy === "impostor" && S.guessFor >= 0) {
        S.players[S.guessFor].score += 2;
      }
      S.players.forEach(function (p) {
        if (p.role === "impostor" && p.alive) p.score += 3;
      });
    } else if (outcome.winner === "blank") {
      if (S.guessFor >= 0) S.players[S.guessFor].score += 3;
    }
    if (typeof opts.firstVoter === "number" && opts.firstVoter >= 0 &&
        S.players[opts.firstVoter] && S.players[opts.firstVoter].role === "civilian") {
      S.players[opts.firstVoter].score += 1;
    }
  }

  function finishRound(outcome, opts) {
    opts = opts || {};
    if (typeof S.pendingBonus === "number" && (typeof opts.firstVoter !== "number" || opts.firstVoter < 0)) {
      opts.firstVoter = S.pendingBonus;
    }
    S.pendingBonus = null;
    applyScoring(outcome, opts);
    S.result = outcome;
    S.phase = "result";
    render();
  }

  // ---------- screens ----------
  function render() {
    stopTimer();
    if (S.phase === "setup") return vSetup();
    if (S.phase === "card") return vCard();
    if (S.phase === "play") return vPlay();
    if (S.phase === "vote") return vVote();
    if (S.phase === "result") return vResult();
    if (S.phase === "final") return vFinal();
  }

  // Screen 1: setup with stepper, name pills, collapsed options.
  function vSetup() {
    var cfg = S.config;
    while (S.setupNames.length < 12) S.setupNames.push("");
    var namesHtml = "";
    for (var i = 0; i < cfg.playerCount; i++) {
      namesHtml += '<input id="name-' + i + '" maxlength="24" value="' + esc(S.setupNames[i]) +
        '" placeholder="Player ' + (i + 1) + '" aria-label="Name of player ' + (i + 1) + '">';
    }
    function sel(id, val, opts) {
      return '<label for="' + id + '">' + id.replace("opt-", "") + "</label>" +
        '<select id="' + id + '">' + opts.map(function (o) {
          return '<option value="' + o[0] + '"' + (val === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
        }).join("") + "</select>";
    }
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:#FFFFFF"><div class="face">' +
      '<h2 class="screen-title">Players</h2>' +
      '<div class="stepper">' +
      '<button id="count-minus" aria-label="Fewer players">−</button>' +
      '<output id="count-val" aria-live="polite">' + cfg.playerCount + "</output>" +
      '<button id="count-plus" aria-label="More players">+</button></div>' +
      '<div class="names">' + namesHtml + "</div>" +
      '<details class="options"><summary>Options</summary><div class="opt-body">' +
      sel("opt-mode", cfg.mode, [["pair", "Mode: Word Pair"], ["single", "Mode: Single Word"]]) +
      sel("opt-diff", cfg.difficulty, [["ALL", "Difficulty: All"], ["E", "Difficulty: Easy"], ["M", "Difficulty: Medium"], ["H", "Difficulty: Hard"]]) +
      '<label class="check-row"><input type="checkbox" id="opt-blank"' + (cfg.blank ? " checked" : "") + "> Blank role (6+ players)</label>" +
      '<label class="check-row"><input type="checkbox" id="opt-timer"' + (cfg.timer ? " checked" : "") + "> 15s clue timer</label>" +
      "</div></details>" +
      '<p class="muted" id="role-preview"></p>' +
      "</div></div>" +
      '<button class="btn" id="b-start">' + SKIP_ICON + "Start game</button>";

    function readNames() {
      for (var k = 0; k < cfg.playerCount; k++) {
        var el = document.getElementById("name-" + k);
        if (el) S.setupNames[k] = el.value.trim();
      }
    }
    function preview() {
      var c = roleCounts(cfg.playerCount, cfg.blank);
      document.getElementById("role-preview").textContent =
        cfg.playerCount + " players: " + c.civilians + " civilian(s), " + c.impostors +
        " impostor(s)" + (c.blank ? ", 1 blank" : "") + ".";
    }
    preview();

    document.getElementById("count-minus").onclick = function () {
      readNames();
      cfg.playerCount = Math.max(4, cfg.playerCount - 1);
      render();
    };
    document.getElementById("count-plus").onclick = function () {
      readNames();
      cfg.playerCount = Math.min(12, cfg.playerCount + 1);
      render();
    };
    document.getElementById("b-start").onclick = function () {
      readNames();
      cfg.mode = document.getElementById("opt-mode").value;
      cfg.difficulty = document.getElementById("opt-diff").value;
      cfg.blank = document.getElementById("opt-blank").checked;
      cfg.timer = document.getElementById("opt-timer").checked;
      if (S.players.length !== cfg.playerCount) {
        S.players = [];
        for (var k = 0; k < cfg.playerCount; k++) S.players.push({ name: "", role: "civilian", alive: true, score: 0 });
      }
      startRound();
    };
  }

  // Screen 2: swipe-up card, one per player. No pass screen: next card starts covered.
  function vCard() {
    var i = S.cardIndex;
    var n = S.players.length;
    if (i >= n) { S.phase = "play"; return render(); }
    var name = playerLabel(i);
    var color = S.colors[i];
    var pill = pillFor(S.players[i].role, S.word);
    var pillHtml = '<div class="pill' + (pill.cls ? " " + pill.cls : "") + '">' + esc(pill.text) + "</div>";
    if (pill.sub) pillHtml += '<p class="sub">Category: ' + esc(pill.sub) + "</p>";
    var last = (i === n - 1);

    root.innerHTML =
      '<div class="stage settle" id="stage" style="--card:' + color + '">' +
      '<div class="face" id="face" aria-hidden="true"><h2 class="name">' + esc(name) + "</h2>" + pillHtml + "</div>" +
      '<div class="sheet" id="sheet" tabindex="0" role="button" ' +
      'aria-label="' + esc(name) + ': swipe up or hold Space to peek at your word. Release to hide.">' +
      '<h2 class="name">' + esc(name) + "</h2>" +
      '<div class="hint"><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M6 15l6-6 6 6"/></svg>Swipe up</div></div></div>' +
      '<button class="btn" id="next" disabled>Swipe up first</button>';

    var stage = document.getElementById("stage");
    var sheet = document.getElementById("sheet");
    var face = document.getElementById("face");
    var next = document.getElementById("next");
    var startY = null, h = 0, seen = false;

    function setP(raw) {
      var v = Math.max(0, raw);
      if (v > 0.75) v = 0.75 + (v - 0.75) * 0.3; // resistance near the top
      v = Math.min(v, 0.9);                       // capped at 90%
      stage.style.setProperty("--p", v);
      face.setAttribute("aria-hidden", v < 0.5 ? "true" : "false");
      if (!seen && v >= 0.5) {
        seen = true;
        buzz(12);
        next.disabled = false;
        next.innerHTML = SKIP_ICON + (last ? "Start game" : "Next player");
      }
    }
    function release() {
      // The word ALWAYS hides on release.
      stage.classList.add("settle");
      stage.style.setProperty("--p", 0);
      face.setAttribute("aria-hidden", "true");
    }
    sheet.addEventListener("pointerdown", function (e) {
      startY = e.clientY; h = stage.clientHeight || 400;
      stage.classList.remove("settle"); stage.classList.add("used");
      try { sheet.setPointerCapture(e.pointerId); } catch (err) {}
    });
    sheet.addEventListener("pointermove", function (e) {
      if (startY !== null) setP((startY - e.clientY) / h);
    });
    function end() { if (startY !== null) { startY = null; release(); } }
    sheet.addEventListener("pointerup", end);
    sheet.addEventListener("pointercancel", end);
    // Keyboard alternative: hold Space or Arrow Up to reveal, release to hide.
    sheet.addEventListener("keydown", function (e) {
      if ((e.key === " " || e.key === "ArrowUp") && !e.repeat) {
        e.preventDefault();
        stage.classList.remove("settle"); stage.classList.add("used");
        setP(0.9);
      }
    });
    sheet.addEventListener("keyup", function (e) {
      if (e.key === " " || e.key === "ArrowUp") release();
    });
    // Rotation or app switch mid-reveal: reset to hidden.
    function hideOnly() {
      stage.classList.add("settle");
      stage.style.setProperty("--p", 0);
      face.setAttribute("aria-hidden", "true");
      startY = null;
    }
    window.addEventListener("resize", hideOnly);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) hideOnly();
    });

    next.onclick = function () {
      window.removeEventListener("resize", hideOnly);
      S.cardIndex++;
      render();
    };
  }

  // Screen 3: play. Mint card, starter, round counter, rules, optional timer.
  function vPlay() {
    var last = S.clueRound >= S.maxRounds;
    var timerHtml = "";
    if (S.config.timer) {
      timerHtml = '<div class="timer" id="t-left">' + S.timerLeft + 's</div>' +
        '<button class="btn" id="b-timer">' + SKIP_ICON + "Start 15s timer</button>";
    }
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:#A9F2B8"><div class="face centered">' +
      '<h2 class="screen-title">' + esc(playerLabel(S.starter)) + " starts</h2>" +
      "<p>One word each. Then vote.</p>" +
      '<p class="muted">Clue round ' + S.clueRound + " of " + S.maxRounds +
      ". Discussion afterwards: about 60&ndash;90s.</p>" +
      timerHtml +
      (last ? "" : '<button class="btn" id="b-next-round">' + SKIP_ICON + "Next clue round</button>") +
      "</div></div>" +
      '<button class="btn" id="b-vote">' + SKIP_ICON + "Vote</button>";

    if (S.config.timer) wireTimer();
    var nx = document.getElementById("b-next-round");
    if (nx) nx.onclick = function () { S.clueRound++; S.timerLeft = CLUE_SECONDS; render(); };
    document.getElementById("b-vote").onclick = function () {
      S.selected = -1;
      S.phase = "vote";
      render();
    };
  }

  function wireTimer() {
    var btn = document.getElementById("b-timer");
    var el = document.getElementById("t-left");
    function armStart() {
      btn.innerHTML = SKIP_ICON + "Start 15s timer";
      btn.onclick = onStart;
    }
    function onStart() {
      stopTimer();
      S.timerLeft = CLUE_SECONDS;
      if (el) el.textContent = CLUE_SECONDS + "s";
      btn.innerHTML = SKIP_ICON + "Reset timer";
      btn.onclick = onReset;
      S.timerId = setInterval(function () {
        S.timerLeft--;
        if (el) el.textContent = Math.max(0, S.timerLeft) + "s";
        if (S.timerLeft <= 0) { stopTimer(); S.timerLeft = CLUE_SECONDS; armStart(); }
      }, 1000);
    }
    function onReset() {
      stopTimer();
      S.timerLeft = CLUE_SECONDS;
      if (el) el.textContent = CLUE_SECONDS + "s";
      armStart();
    }
    armStart();
  }

  // Screen 4: vote with name pills. Selected pill fills with its card color.
  function vVote() {
    var pills = "";
    S.players.forEach(function (p, i) {
      if (!p.alive) return;
      pills += '<button class="vote-pill" id="vote-pick-' + i + '" aria-pressed="' +
        (S.selected === i ? "true" : "false") + '" style="--pick:' + S.colors[i] + '">' +
        esc(playerLabel(i)) + "</button>";
    });
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:#FFFFFF"><div class="face">' +
      '<h2 class="screen-title">Who is it?</h2>' +
      '<p class="muted">Tap a name, then confirm.</p>' +
      '<div class="vote-grid">' + pills + "</div>" +
      (S.revoted ? '<p class="muted">Revote after the tie.</p>' : "") +
      "</div></div>" +
      '<button class="btn" id="b-confirm"' + (S.selected < 0 ? " disabled" : "") + ">" + SKIP_ICON + "Confirm</button>" +
      '<button class="btn" id="b-tie">' + SKIP_ICON + "Vote tied</button>";

    S.players.forEach(function (p, i) {
      if (!p.alive) return;
      document.getElementById("vote-pick-" + i).onclick = function () {
        S.selected = i;
        render();
      };
    });
    document.getElementById("b-confirm").onclick = function () {
      if (S.selected >= 0) eliminate(S.selected);
    };
    document.getElementById("b-tie").onclick = function () {
      if (!S.revoted) {
        S.revoted = true; // one revote
        render();
      } else {
        // Still tied: nobody eliminated, another clue round.
        S.revoted = false;
        S.maxRounds++;
        S.phase = "play";
        render();
      }
    };
  }

  function eliminate(idx) {
    S.players[idx].alive = false;
    var role = S.players[idx].role;
    if (role === "impostor" || role === "blank") {
      S.guessFor = idx;
      vGuess(); // final-guess step
      return;
    }
    vElimReveal(idx, role);
  }

  // Elimination reveal for a civilian (or blank already handled): show role, continue.
  function vElimReveal(idx, role) {
    var line = role === "blank" ? "was the blank" : "was a civilian";
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:' + S.colors[idx] + '"><div class="face centered">' +
      '<h2 class="screen-title">' + esc(playerLabel(idx)) + " " + line + "</h2>" +
      "<p>No final guess. The game goes on.</p>" +
      "</div></div>" +
      '<button class="btn" id="b-continue">' + SKIP_ICON + "Continue</button>";
    document.getElementById("b-continue").onclick = function () {
      var win = checkWin();
      if (win) { finishRound(win, { guessCorrect: false }); return; }
      S.maxRounds++;
      S.revoted = false;
      S.phase = "play";
      render();
    };
  }

  // Final-guess step for an eliminated impostor or blank.
  function vGuess() {
    var idx = S.guessFor;
    var p = S.players[idx];
    var isBlank = p.role === "blank";
    var line = isBlank ? "was the blank" : "was the impostor";
    var firstOpts = '<option value="-1">Nobody / skip</option>' + S.players.map(function (q, i) {
      if (q.role !== "civilian") return "";
      return '<option value="' + i + '">' + esc(playerLabel(i)) + "</option>";
    }).join("");
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:' + S.colors[idx] + '"><div class="face centered">' +
      '<h2 class="screen-title">' + esc(playerLabel(idx)) + " " + line + "</h2>" +
      "<p>Final guess: name the secret word now. " +
      (isBlank ? "A correct guess wins the game for the blank."
               : "A correct guess steals the win for the impostors.") +
      ' (Host: the word is <strong>"' + esc(S.word.civilian) + '"</strong>.)</p>' +
      '<label for="f-first">Who called them out first? (civilian +1)</label>' +
      '<select id="f-first">' + firstOpts + "</select>" +
      "</div></div>" +
      '<button class="btn" id="b-right">' + SKIP_ICON + "Guess correct</button>" +
      '<button class="btn" id="b-wrong">' + SKIP_ICON + "Guess wrong</button>";
    document.getElementById("b-right").onclick = function () {
      var first = parseInt(document.getElementById("f-first").value, 10);
      if (isBlank) {
        finishRound({ winner: "blank", reason: "The blank guessed the secret word." },
          { guessCorrect: true, guessBy: "blank", firstVoter: first });
      } else {
        finishRound({ winner: "impostors", reason: "The eliminated impostor guessed the secret word." },
          { guessCorrect: true, guessBy: "impostor", firstVoter: first });
      }
    };
    document.getElementById("b-wrong").onclick = function () {
      var first = parseInt(document.getElementById("f-first").value, 10);
      var win = checkWin();
      if (win) { finishRound(win, { guessCorrect: false, firstVoter: first }); return; }
      S.maxRounds++;
      S.revoted = false;
      S.pendingBonus = first;
      S.phase = "play";
      render();
    };
  }

  function scoreTable() {
    var rows = S.players.map(function (p, i) {
      var tag = p.alive ? "" : " (out)";
      return "<tr><td>" + esc(playerLabel(i)) + esc(tag) + "</td><td>" + p.score + "</td></tr>";
    }).join("");
    return "<table><tr><th>Player</th><th>Points</th></tr>" + rows + "</table>";
  }

  // Screen 5: result. Cyan for civilians, pink for impostors (safe: roles are public now).
  function vResult() {
    var r = S.result;
    var title = r.winner === "civilians" ? "Civilians win!"
      : r.winner === "impostors" ? "Impostors win!" : "Blank wins!";
    var card = r.winner === "civilians" ? "#88F5F5" : r.winner === "impostors" ? "#F4B3D4" : "#F6EE8A";
    var whoIdx = S.guessFor >= 0 ? S.guessFor : -1;
    var whoLine = whoIdx >= 0
      ? esc(playerLabel(whoIdx)) + (S.players[whoIdx].role === "blank" ? " was the blank" : " was the impostor")
      : esc(r.reason);
    var wordsLine = S.config.mode === "pair"
      ? "Civilians: \u201C" + S.word.civilian + "\u201D / Impostor: \u201C" + S.word.impostor +
        "\u201D (" + S.word.theme + ")."
      : "Word: \u201C" + S.word.civilian + "\u201D (" + S.word.theme + ").";
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:' + card + '"><div class="face centered">' +
      '<h2 class="screen-title">' + title + "</h2>" +
      "<p><strong>" + whoLine + "</strong></p>" +
      "<p>" + esc(wordsLine) + "</p>" +
      scoreTable() +
      "</div></div>" +
      '<button class="btn" id="b-next-round">' + SKIP_ICON + "Next round</button>" +
      '<button class="btn" id="b-end">' + SKIP_ICON + "End game</button>";
    document.getElementById("b-next-round").onclick = function () { startRound(); };
    document.getElementById("b-end").onclick = function () { S.phase = "final"; render(); };
  }

  function vFinal() {
    var order = S.players.map(function (p, i) { return i; }).sort(function (a, b) {
      return S.players[b].score - S.players[a].score;
    });
    var rows = order.map(function (i) {
      return "<tr><td>" + esc(playerLabel(i)) + "</td><td>" + S.players[i].score + "</td></tr>";
    }).join("");
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:#FFFFFF"><div class="face centered">' +
      '<h2 class="screen-title">Final scores</h2>' +
      "<table><tr><th>Player</th><th>Points</th></tr>" + rows + "</table>" +
      "</div></div>" +
      '<button class="btn" id="b-again">' + SKIP_ICON + "Play again</button>" +
      '<button class="btn" id="b-setup">' + SKIP_ICON + "Change setup</button>";
    document.getElementById("b-again").onclick = function () {
      S.players.forEach(function (p) { p.score = 0; });
      startRound();
    };
    document.getElementById("b-setup").onclick = function () { S.phase = "setup"; render(); };
  }

  // Export pure helpers for automated tests (no-op in the browser).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      roleCounts: roleCounts,
      assignRoles: assignRoles,
      __test: {
        setWords: function (w) { S.allWords = w; },
        setConfig: function (c) { S.config = c; },
        resetUsed: function () { S.usedIds = []; },
        pickWord: pickWord,
        used: function () { return S.usedIds.slice(); }
      }
    };
  }

  // ---------- boot: the only network call ----------
  document.getElementById("quit").onclick = quitToSetup;
  loadUsed();
  fetch("data/words.json")
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      S.allWords = data;
      render();
    })
    .catch(function () {
      root.innerHTML = '<div class="stage stage-pad" style="--card:#FFFFFF"><div class="face">' +
        "<h2>Could not load words</h2>" +
        "<p>Serve the <code>dist/</code> folder over HTTP (for example " +
        "<code>npx serve dist</code>) or deploy with Firebase Hosting, then reload.</p></div></div>";
    });
})();
