/* The Impostor Game - vanilla JS, no frameworks.
   Single network call at startup (words.json); everything else is in memory.
   UI: 5 screens (Setup, Card, Play, Vote, Result) per UI_PROMPT.md.
   Card reveal: swipe-up sheet adapted from reveal-demo.html (peek, don't keep).
   State machine: setup > card > play > vote > result > (next round | final). */
(function () {
  "use strict";

  var REVEAL_MS = 3000; // carousel runs 3 seconds, then the impostor is shown

  // Card colors follow the player's avatar background (standard rule across
  // the app: a player's card is always their avatar color, never their role).
  var AVATAR_BG = ["#ffe3ea", "#e3edff", "#e2f5e9", "#fdf1d4", "#efe6ff"];

  var root = document.getElementById("app");

  // ---- Session state (in memory; usedIds also mirrored to localStorage) ----
  var S = {
    phase: "setup",
    allWords: [],
    config: { playerCount: 5, mode: "pair", blank: false, difficulty: "ALL" },
    setupNames: [],
    setupStep: 1,       // setup wizard: 1 = players, 2 = options
    setupEdit: 0,       // player index under edit in the paged editor
    players: [],        // { name, role, alive, score }
    colors: [],         // card color per player-order index
    word: null,
    usedIds: [],
    cardIndex: 0,
    clueRound: 1,
    maxRounds: 2,
    starter: 0,
    timerId: null,
    guessFor: -1,
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
    if (S.timerId) { clearInterval(S.timerId); clearTimeout(S.timerId); S.timerId = null; }
  }

  function playerLabel(i) {
    return (S.players[i] && S.players[i].name) || ("Player " + (i + 1));
  }

  // Self-hosted DiceBear avatars (dist/avatars). Assigned by player order,
  // never by role — same privacy rule as card colors. Fully offline.
  // Palette matches the baked-in SVG backgrounds (cycled the same way).
  var AVATAR_BG = ["#ffe3ea", "#e3edff", "#e2f5e9", "#fdf1d4", "#efe6ff"];
  function avatarFor(i) {
    return "avatars/p" + ((i % 12) + 1) + ".svg";
  }
  function avatarBg(i) {
    return AVATAR_BG[i % AVATAR_BG.length];
  }

  function quitToSetup() {
    if (S.phase === "setup") return;
    if (window.confirm("Quit this round and go back to setup?")) {
      stopTimer();
      S.phase = "setup";
      S.setupStep = 1;
      S.setupEdit = 0;
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
  // single-mode impostor gets the red alert + one combined hint line
  // ("Hint: Household Flame"); blank gets "???".
  var SHORT_THEME = {
    "Food & Drink": "Food", "Home & Household": "Household", "Animals": "Animals",
    "Travel & Places": "Travel", "Entertainment": "Entertainment", "Work & School": "Work",
    "Sports & Fitness": "Sports", "Fantasy & Pop Culture": "Fantasy"
  };
  function shortTheme(t) { return SHORT_THEME[t] || t; }
  function pillFor(role, word) {
    if (role === "blank") return { cls: "", text: "???" };
    if (role === "civilian") return { cls: "", text: word.civilian };
    if (S.config.mode === "single") {
      return { cls: "alert", text: "You are the impostor!", hint: shortTheme(word.theme) + " " + word.impostor.replace(/^Hint:\s*/, "") };
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
        '<button class="btn" id="b-back">Back to setup</button></div></div>';
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
    for (var c = 0; c < n; c++) S.colors.push(avatarBg(c));
    S.word = word;
    S.cardIndex = 0;
    S.clueRound = 1;
    S.maxRounds = n >= 8 ? 3 : 2;
    S.starter = Math.floor(Math.random() * n);
    S.guessFor = -1;
    S.result = null;
    S.setupStep = 1;
    S.setupEdit = 0;
    S.phase = "card";
    render();
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
    applyScoring(outcome, opts || {});
    S.result = outcome;
    S.phase = "result";
    render();
  }

  // ---------- screens ----------
  function render() {
    stopTimer();
    // The close button only makes sense mid-round; hide it on meta screens.
    var quit = document.getElementById("quit");
    if (quit) quit.style.display = (S.phase === "setup" || S.phase === "final") ? "none" : "";
    if (S.phase === "setup") return vSetup();
    if (S.phase === "card") return vCard();
    if (S.phase === "play") return vPlay();
    if (S.phase === "reveal") return vRevealCarousel();
    if (S.phase === "impostor") return vImpostorReveal();
    if (S.phase === "guess") return vGuessImpostor();
    if (S.phase === "blankguess") return vGuessBlank();
    if (S.phase === "result") return vResult();
    if (S.phase === "final") return vFinal();
  }

  // Screen 1: setup wizard.
  // Step 1 (Players): stepper + big avatar preview + nickname input,
  // main Next button plus small Prev/Next buttons below.
  // Step 2 (Added players): review roster, Confirm to continue.
  // Step 3 (Options): dedicated place for mode, difficulty and blank.
  function vSetup() {
    var cfg = S.config;
    while (S.setupNames.length < 12) S.setupNames.push("");
    if (S.setupEdit >= cfg.playerCount) S.setupEdit = cfg.playerCount - 1;
    if (S.setupStep === 1) return vSetupPlayers(cfg);
    if (S.setupStep === 2) return vSetupReview(cfg);
    return vSetupOptions(cfg);
  }

  function saveEditor(cfg) {
    var el = document.getElementById("pname");
    if (el) S.setupNames[S.setupEdit] = el.value.trim();
  }

  function stepperHtml(cfg) {
    return '<div class="stepper">' +
      '<button id="count-minus" aria-label="Fewer players">−</button>' +
      '<output id="count-val" aria-live="polite">' + cfg.playerCount + "</output>" +
      '<button id="count-plus" aria-label="More players">+</button></div>';
  }

  function wireStepper(cfg) {
    document.getElementById("count-minus").onclick = function () {
      saveEditor(cfg);
      cfg.playerCount = Math.max(4, cfg.playerCount - 1);
      render();
    };
    document.getElementById("count-plus").onclick = function () {
      saveEditor(cfg);
      cfg.playerCount = Math.min(12, cfg.playerCount + 1);
      render();
    };
  }

  function vSetupPlayers(cfg) {
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:' + avatarBg(S.setupEdit) + '"><div class="face">' +
      '<h2 class="screen-title">Who is playing?</h2>' +
      stepperHtml(cfg) +
      '<img class="avatar-big" src="' + avatarFor(S.setupEdit) + '" alt="">' +
      '<p class="muted">Player ' + (S.setupEdit + 1) + " of " + cfg.playerCount + "</p>" +
      '<label class="offscreen" for="pname">Nickname for player ' + (S.setupEdit + 1) + "</label>" +
      '<input id="pname" class="nick" maxlength="24" value="' + esc(S.setupNames[S.setupEdit]) + '"' +
      ' placeholder="Type a nickname" autocomplete="off" aria-describedby="req-hint">' +
      '<p class="req-hint" id="req-hint" role="alert">Nickname required to continue.</p>' +
      "</div></div>" +
      (S.setupEdit === 0
        ? '<button class="btn" id="ed-next">Next</button>'
        : '<div class="mini-nav" id="setup-nav">' +
          '<button class="btn-mini" id="ed-prev">Prev</button>' +
          '<button class="btn-mini" id="ed-next">Next</button>' +
          "</div>");

    wireStepper(cfg);
    var input = document.getElementById("pname");
    var hint = document.getElementById("req-hint");
    function norm(s) { return String(s).trim().toLowerCase().replace(/\s+/g, " "); }
    // A nickname is taken when another player already uses it (case-insensitive).
    function dupOf(v) {
      for (var k = 0; k < cfg.playerCount; k++) {
        if (k !== S.setupEdit && norm(S.setupNames[k]) === norm(v)) return true;
      }
      return false;
    }
    function err(msg) {
      if (hint) { hint.textContent = msg; hint.className = "req-hint err"; }
    }
    function clearErr() {
      if (hint) { hint.textContent = "Nickname required to continue."; hint.className = "req-hint"; }
    }
    input.oninput = function () {
      if (hint && hint.className.indexOf("err") >= 0) clearErr();
    };
    function advance() {
      saveEditor(cfg);
      var v = S.setupNames[S.setupEdit].trim();
      if (v === "") { err("Please type a nickname to continue."); return; }
      if (dupOf(v)) { err("That nickname is already taken."); return; }
      if (S.setupEdit >= cfg.playerCount - 1) {
        // Safety net: never leave an unnamed player behind.
        for (var k = 0; k < cfg.playerCount; k++) {
          if (!S.setupNames[k].trim()) { S.setupEdit = k; render(); return; }
        }
        S.setupStep = 2;
        render();
      } else {
        S.setupEdit = Math.min(cfg.playerCount - 1, S.setupEdit + 1);
        render();
      }
    }
    document.getElementById("ed-next").onclick = advance;
    var prevMini = document.getElementById("ed-prev");
    if (prevMini) prevMini.onclick = function () {
      saveEditor(cfg);
      S.setupEdit = Math.max(0, S.setupEdit - 1);
      render();
    };
  }

  function vSetupReview(cfg) {
    var rows = "";
    for (var i = 0; i < cfg.playerCount; i++) {
      rows += '<li style="background:' + avatarBg(i) + '"><img src="' + avatarFor(i) +
        '" alt="" width="40" height="40">' + esc(S.setupNames[i]) + "</li>";
    }
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:#FFFFFF"><div class="face">' +
      '<h2 class="screen-title">Added players</h2>' +
      '<ul class="roster">' + rows + "</ul>" +
      "</div></div>" +
      '<button class="btn" id="b-confirm-roster">Confirm</button>' +
      '<button class="btn secondary" id="b-back-players">‹ Back</button>';
    document.getElementById("b-confirm-roster").onclick = function () {
      S.setupStep = 3;
      render();
    };
    document.getElementById("b-back-players").onclick = function () {
      S.setupStep = 1;
      S.setupEdit = 0;
      render();
    };
  }

  function vSetupOptions(cfg) {
    if (cfg.playerCount < 6) cfg.blank = false; // blank needs 6+ players: hide it
    var DIFF_ORDER = ["ALL", "E", "M", "H"];
    var DIFF_LABEL = { ALL: "All", E: "Easy", M: "Medium", H: "Hard" };
    function segBtn(id, group, val, title) {
      return '<button id="' + id + '" aria-pressed="' + (group === val ? "true" : "false") + '">' +
        "<b>" + esc(title) + "</b></button>";
    }
    function switchBtn(id, on, label) {
      return '<button class="switch" id="' + id + '" role="switch" aria-checked="' +
        (on ? "true" : "false") + '"><span>' + esc(label) + '</span><span class="badge">' +
        (on ? "On" : "Off") + "</span></button>";
    }
    var c = roleCounts(cfg.playerCount, cfg.blank);
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:#F6EE8A"><div class="face">' +
      '<h2 class="screen-title">Game options</h2>' +
      '<div class="seg mode" role="group" aria-label="Game mode">' +
      segBtn("opt-mode-pair", cfg.mode, "pair", "Word Pair") +
      segBtn("opt-mode-single", cfg.mode, "single", "Single Word") +
      "</div>" +
      '<button class="switch" id="opt-diff-cycle"><span>Difficulty</span>' +
      '<span class="badge">' + DIFF_LABEL[cfg.difficulty] + "</span></button>" +
      (cfg.playerCount >= 6 ? switchBtn("opt-blank", cfg.blank, "Blank role") : "") +
      '<p class="muted" id="role-preview">' + cfg.playerCount + " players: " + c.civilians +
      " civilian(s), " + c.impostors + " impostor(s)" + (c.blank ? ", 1 blank" : "") + ".</p>" +
      "</div></div>" +
      '<button class="btn" id="b-start">Start game</button>' +
      '<button class="btn secondary" id="b-back-review">‹ Back</button>';

    function pickMode(v) { return function () { cfg.mode = v; render(); }; }
    document.getElementById("opt-mode-pair").onclick = pickMode("pair");
    document.getElementById("opt-mode-single").onclick = pickMode("single");
    document.getElementById("opt-diff-cycle").onclick = function () {
      cfg.difficulty = DIFF_ORDER[(DIFF_ORDER.indexOf(cfg.difficulty) + 1) % DIFF_ORDER.length];
      render();
    };
    function flip(key) {
      return function () {
        cfg[key] = !cfg[key];
        render();
      };
    }
    var blankBtn = document.getElementById("opt-blank");
    if (blankBtn) blankBtn.onclick = flip("blank");
    document.getElementById("b-back-review").onclick = function () {
      S.setupStep = 2;
      render();
    };
    document.getElementById("b-start").onclick = function () {
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
    if (pill.hint) pillHtml += '<p class="sub">Hint: ' + esc(pill.hint) + "</p>";
    var last = (i === n - 1);

    root.innerHTML =
      '<div class="stage swipe settle" id="stage" style="--card:' + color + '">' +
      '<div class="face" id="face" aria-hidden="true">' +
      '<img class="avatar" src="' + avatarFor(i) + '" alt="">' +
      '<h2 class="name">' + esc(name) + "</h2>" + pillHtml + "</div>" +
      '<div class="sheet" id="sheet" tabindex="0" role="button" ' +
      'aria-label="' + esc(name) + ': swipe up or hold Space to peek at your word. Release to hide.">' +
      '<img class="avatar" src="' + avatarFor(i) + '" alt="">' +
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
        next.innerHTML = (last ? "Start game" : "Next player");
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

  // Screen 3: play. Starter card plus the speaking-order strip, then reveal.
  function vPlay() {
    var n = S.players.length;
    var chips = "";
    var k;
    for (k = 0; k < n; k++) {
      var p = (S.starter + k) % n;
      chips += '<div class="turn-chip' + (k === 0 ? " lead" : "") + '">' +
        '<img src="' + avatarFor(p) + '" alt=""><span>' + esc(playerLabel(p)) + "</span></div>";
    }
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:' + avatarBg(S.starter) + '"><div class="face centered">' +
      '<img class="avatar" src="' + avatarFor(S.starter) + '" alt="">' +
      '<h2 class="screen-title">' + esc(playerLabel(S.starter)) + " starts</h2>" +
      "<p>One word each, in order. Then reveal.</p>" +
      '<div class="turn-row">' + chips + "</div>" +
      "</div></div>" +
      '<button class="btn" id="b-reveal">Reveal the impostor</button>';

    document.getElementById("b-reveal").onclick = function () {
      S.phase = "reveal";
      render();
    };
  }

  // Screen 4: impostor carousel. Avatar cards spin for 3 seconds, then land
  // on the impostor. No voting: the reveal itself ends the round.
  function impostorIndexes() {
    var out = [];
    S.players.forEach(function (p, i) { if (p.role === "impostor") out.push(i); });
    return out;
  }

  function vRevealCarousel() {
    var imps = impostorIndexes();
    var target = imps[0];
    // Build a long strip of player cards; force the last card to be the impostor
    // (second-to-last is forced non-impostor for a last-moment fake-out).
    var N = 30;
    var deck = [];
    var k;
    for (k = 0; k < N - 1; k++) {
      deck.push(Math.floor(Math.random() * S.players.length));
    }
    if (deck[N - 2] === target) {
      deck[N - 2] = (target + 1) % S.players.length;
    }
    deck.push(target);
    var cards = deck.map(function (p) {
      return '<div class="au-card" style="background:' + avatarBg(p) + '">' +
        '<img src="' + avatarFor(p) + '" alt="">' +
        "<p>" + esc(playerLabel(p)) + "</p></div>";
    }).join("");
    root.innerHTML =
      '<div class="stage au-reveal"><h2 class="au-title">Impostor</h2>' +
      '<div class="au-band" id="au-band"><div class="au-track" id="au-track">' + cards + "</div>" +
      '<div class="au-pointer"></div></div>' +
      '<p class="au-name" id="reveal-name">Finding the impostor&hellip;</p></div>' +
      '<button class="btn secondary" id="b-skip-reveal">Skip</button>';

    var reduced = (typeof window !== "undefined" && window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (reduced) { S.phase = "impostor"; render(); return; }
    var band = document.getElementById("au-band");
    var track = document.getElementById("au-track");
    var CARD_W = 92, GAP = 10, STEP = CARD_W + GAP;
    function finish() { S.phase = "impostor"; render(); }
    // Center cards at both ends: pad so first and last cards can sit mid-band.
    function layout() {
      var bandW = band ? band.clientWidth : 300;
      var pad = Math.max(0, bandW / 2 - CARD_W / 2);
      track.style.paddingLeft = pad + "px";
      track.style.paddingRight = pad + "px";
      return (N - 1) * STEP;
    }
    var distance = layout();
    // Start flush left, then ease-out scroll to the impostor card.
    track.style.transform = "translateX(0px)";
    void track.offsetWidth; // reflow so the transition runs
    track.style.transition = "transform " + REVEAL_MS + "ms cubic-bezier(0.15, 0.85, 0.25, 1)";
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          track.style.transform = "translateX(" + (-distance) + "px)";
        });
      });
    } else {
      track.style.transform = "translateX(" + (-distance) + "px)";
    }
    S.timerId = setTimeout(finish, REVEAL_MS + 150);
    document.getElementById("b-skip-reveal").onclick = function () {
      S.phase = "impostor";
      render();
    };
  }

  // Screen 5: the reveal. Among Us look: black screen, red IMPOSTOR title,
  // impostor avatar(s) centered on the red band. Roles are public now.
  function vImpostorReveal() {
    var imps = impostorIndexes();
    S.guessFor = imps[0];
    var names = imps.map(function (i) { return playerLabel(i); }).join(" and ");
    var suffix = imps.length > 1 ? "were the impostors" : "was the impostor";
    var faces = imps.map(function (i) {
      return '<div class="au-face" style="background:' + avatarBg(i) + '">' +
        '<img src="' + avatarFor(i) + '" alt=""></div>';
    }).join("");
    root.innerHTML =
      '<div class="stage au-reveal"><h2 class="au-title">Impostor</h2>' +
      '<div class="reveal-row">' + faces + "</div>" +
      '<h2 class="au-name-big">' + esc(names) + "</h2>" +
      "<p class=\"au-sub\">" + esc(suffix) + "</p></div>" +
      '<button class="btn" id="b-to-guess">Final guess</button>';
    document.getElementById("b-to-guess").onclick = function () {
      S.phase = "guess";
      render();
    };
  }

  // Final guess: the revealed impostor names the secret word to steal the win.
  // Verdict is a red X (wrong) on the left, green check (right) on the right.
  function guessButtons(rightId, wrongId) {
    return '<div class="guess-row">' +
      '<button class="guess-btn wrong" id="' + wrongId + '" aria-label="Wrong guess">&#10005;</button>' +
      '<button class="guess-btn right" id="' + rightId + '" aria-label="Correct guess">&#10003;</button></div>';
  }
  function vGuessImpostor() {
    var idx = S.guessFor;
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:' + S.colors[idx] + '"><div class="face centered">' +
      '<img class="avatar" src="' + avatarFor(idx) + '" alt="">' +
      '<h2 class="screen-title">Let ' + esc(playerLabel(idx)) + " guess</h2>" +
      "<p>" + esc(playerLabel(idx)) + ", name the secret word now. A correct guess steals " +
      'the win for the impostors. (Host: the word is <strong>"' + esc(S.word.civilian) + '"</strong>.)</p>' +
      "</div></div>" +
      guessButtons("b-guess-right", "b-guess-wrong");
    document.getElementById("b-guess-right").onclick = function () {
      finishRound({ winner: "impostors", reason: "The impostor guessed the secret word." },
        { guessCorrect: true, guessBy: "impostor" });
    };
    document.getElementById("b-guess-wrong").onclick = function () {
      var blankIdx = -1;
      S.players.forEach(function (p, i) { if (p.role === "blank" && blankIdx < 0) blankIdx = i; });
      if (blankIdx >= 0) { S.guessFor = blankIdx; S.phase = "blankguess"; render(); return; }
      finishRound({ winner: "civilians", reason: "The impostor failed to guess the secret word." }, {});
    };
  }

  // Blank's turn: a correct guess wins the game for the blank.
  function vGuessBlank() {
    var idx = S.guessFor;
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:' + S.colors[idx] + '"><div class="face centered">' +
      '<img class="avatar" src="' + avatarFor(idx) + '" alt="">' +
      '<h2 class="screen-title">Let ' + esc(playerLabel(idx)) + " guess</h2>" +
      "<p>" + esc(playerLabel(idx)) + ", you saw nothing all game. Name the secret word now " +
      'to steal the win. (Host: the word is <strong>"' + esc(S.word.civilian) + '"</strong>.)</p>' +
      "</div></div>" +
      guessButtons("b-blank-right", "b-blank-wrong");
    document.getElementById("b-blank-right").onclick = function () {
      finishRound({ winner: "blank", reason: "The blank guessed the secret word." },
        { guessCorrect: true, guessBy: "blank" });
    };
    document.getElementById("b-blank-wrong").onclick = function () {
      finishRound({ winner: "civilians", reason: "Nobody guessed the secret word." }, {});
    };
  }

  // Gamified scoreboard: ranked rows with avatars, leader highlighted.
  function scoreBoard() {
    var order = S.players.map(function (p, i) { return i; }).sort(function (a, b) {
      return S.players[b].score - S.players[a].score;
    });
    var rows = order.map(function (i, r) {
      var pts = S.players[i].score;
      return '<li class="score-row' + (r === 0 ? " lead" : "") + '">' +
        '<span class="rank">' + (r + 1) + "</span>" +
        '<img src="' + avatarFor(i) + '" alt="">' +
        '<span class="sname">' + esc(playerLabel(i)) + "</span>" +
        '<span class="pts">' + pts + " pt" + (pts === 1 ? "" : "s") + "</span></li>";
    }).join("");
    return '<ul class="scores">' + rows + "</ul>";
  }

  // Falling confetti for the result reveal. Skipped for reduced motion.
  function confettiHtml() {
    var reduced = (typeof window !== "undefined" && window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (reduced) return "";
    var colors = ["#D62020", "#F6EE8A", "#88F5F5", "#A9F2B8", "#CDBDF7", "#FFC8A2", "#FFFFFF"];
    var out = "";
    var f;
    for (f = 0; f < 28; f++) {
      var w = 6 + Math.floor(Math.random() * 6);
      out += '<i class="confetti" style="left:' + (Math.random() * 100).toFixed(1) +
        "%;background:" + colors[f % colors.length] +
        ";width:" + w + "px;height:" + Math.round(w * 1.6) +
        "px;animation-delay:" + (Math.random() * 2).toFixed(2) +
        "s;animation-duration:" + (2.5 + Math.random() * 2.5).toFixed(2) + 's"></i>';
    }
    return out;
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
      '<div class="stage stage-pad" style="--card:' + card + '">' + confettiHtml() + '<div class="face centered">' +
      '<h2 class="screen-title">' + title + "</h2>" +
      "<p><strong>" + whoLine + "</strong></p>" +
      "<p>" + esc(wordsLine) + "</p>" +
      scoreBoard() +
      "</div></div>" +
      '<button class="btn" id="b-next-round">Next round</button>' +
      '<button class="btn" id="b-end">End game</button>';
    document.getElementById("b-next-round").onclick = function () { startRound(); };
    document.getElementById("b-end").onclick = function () { S.phase = "final"; render(); };
  }

  function vFinal() {
    root.innerHTML =
      '<div class="stage stage-pad" style="--card:#FFFFFF"><div class="face centered">' +
      '<h2 class="screen-title">Final scores</h2>' +
      scoreBoard() +
      "</div></div>" +
      '<button class="btn" id="b-again">Play again</button>' +
      '<button class="btn" id="b-setup">Change setup</button>';
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
