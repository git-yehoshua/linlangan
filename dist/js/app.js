/* The Impostor Game - vanilla JS, no frameworks.
   Single network call at startup (words.json); everything else is in memory.
   State machine: setup > reveal > clues > vote > result > (next round | final). */
(function () {
  "use strict";

  var CLUE_SECONDS = 15;
  var DISCUSS_MIN = 60;
  var DISCUSS_MAX = 90;

  var root = document.getElementById("app");

  // ---- Session state (in memory; usedIds also mirrored to localStorage) ----
  var S = {
    phase: "setup",
    allWords: [],
    config: { playerCount: 5, mode: "pair", blank: false, difficulty: "ALL" },
    players: [],        // { name, role, alive, score }
    word: null,         // current word entry
    usedIds: [],
    revealIndex: 0,     // which player is receiving the device
    revealOpen: false,  // word currently shown?
    clueRound: 1,
    maxRounds: 2,
    starter: 0,
    timerLeft: CLUE_SECONDS,
    timerId: null,
    eliminated: [],     // player indexes voted out this round-game
    revoted: false,     // tie revote already used for current vote
    pendingElim: -1,    // selected but not yet confirmed
    guessFor: -1,       // player index awaiting final-guess verdict
    result: null        // { winner, reason }
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
    return S.players[i].name || ("Player " + (i + 1));
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

  // What each role sees on their card.
  function cardFor(role, word) {
    if (role === "blank") return "???";
    if (role === "civilian") return word.civilian;
    // impostor: similar word in pair mode, category hint in single mode
    return word.impostor;
  }

  // ---------- round setup ----------
  function startRound() {
    stopTimer();
    var cfg = S.config;
    var n = cfg.playerCount;
    var word = pickWord();
    if (!word) {
      root.innerHTML = '<div class="card"><h2>No words available</h2>' +
        "<p>No words match this mode/difficulty. Try another filter.</p>" +
        '<button id="b-back">Back to setup</button></div>';
      document.getElementById("b-back").onclick = function () { S.phase = "setup"; render(); };
      return;
    }
    var roles = assignRoles(n, cfg.blank);
    // Keep scores across rounds; (re)create players on first round or count change.
    if (S.players.length !== n) {
      S.players = [];
      for (var i = 0; i < n; i++) S.players.push({ name: "", role: roles[i], alive: true, score: 0 });
    } else {
      for (var k = 0; k < n; k++) { S.players[k].role = roles[k]; S.players[k].alive = true; }
    }
    S.word = word;
    S.revealIndex = 0;
    S.revealOpen = false;
    S.clueRound = 1;
    S.maxRounds = n >= 8 ? 3 : 2;
    S.starter = Math.floor(Math.random() * n);
    S.timerLeft = CLUE_SECONDS;
    S.eliminated = [];
    S.revoted = false;
    S.pendingElim = -1;
    S.guessFor = -1;
    S.result = null;
    S.phase = "reveal";
    render();
  }

  // ---------- win check (PRD FR6) ----------
  // Returns { winner, reason } or null when play continues.
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

  // ---------- scoring (PRD FR7) ----------
  // opts: { guessCorrect: bool, guessBy: role, firstVoter: index|-1 }
  function applyScoring(outcome, opts) {
    opts = opts || {};
    if (outcome.winner === "civilians") {
      S.players.forEach(function (p) {
        if (p.role === "civilian" && p.alive) p.score += 1;
      });
    } else if (outcome.winner === "impostors") {
      if (opts.guessCorrect) {
        // Eliminated impostor who guessed correctly: +2.
        if (opts.guessBy === "impostor" && S.guessFor >= 0) S.players[S.guessFor].score += 2;
        // Surviving impostor teammates share the win: +3 each.
        S.players.forEach(function (p) {
          if (p.role === "impostor" && p.alive) p.score += 3;
        });
      } else {
        S.players.forEach(function (p) {
          if (p.role === "impostor" && p.alive) p.score += 3;
        });
      }
    } else if (outcome.winner === "blank") {
      if (S.guessFor >= 0) S.players[S.guessFor].score += 3;
    }
    if (typeof opts.firstVoter === "number" && opts.firstVoter >= 0 &&
        S.players[opts.firstVoter] && S.players[opts.firstVoter].role === "civilian") {
      S.players[opts.firstVoter].score += 1;
    }
  }

  // ---------- screens ----------
  function render() {
    stopTimer();
    if (S.phase === "setup") return vSetup();
    if (S.phase === "reveal") return vReveal();
    if (S.phase === "clues") return vClues();
    if (S.phase === "vote") return vVote();
    if (S.phase === "guess") return vGuess();
    if (S.phase === "result") return vResult();
    if (S.phase === "final") return vFinal();
  }

  function namesField() {
    var saved = S.players.map(function (p) { return p.name; }).join(", ");
    return '<label for="f-names">Names (optional, comma-separated)</label>' +
      '<input type="text" id="f-names" maxlength="200" value="' + esc(saved) + '" ' +
      'placeholder="e.g. Ana, Ben, Cho, Dee, Eli">';
  }

  // FR1: setup screen
  function vSetup() {
    var cfg = S.config;
    var modes = [["pair", "Word Pair"], ["single", "Single Word"]];
    var diffs = [["ALL", "All"], ["E", "Easy"], ["M", "Medium"], ["H", "Hard"]];
    var h = '<div class="card"><h2>Game setup</h2>' +
      '<label for="f-count">Players (4&ndash;12)</label>' +
      '<input type="number" id="f-count" min="4" max="12" value="' + cfg.playerCount + '">' +
      namesField() +
      '<label for="f-mode">Mode</label><select id="f-mode">' +
      modes.map(function (m) {
        return '<option value="' + m[0] + '"' + (cfg.mode === m[0] ? " selected" : "") + ">" + m[1] + "</option>";
      }).join("") + "</select>" +
      '<div class="checkbox-row"><input type="checkbox" id="f-blank"' + (cfg.blank ? " checked" : "") + ">" +
      '<label for="f-blank">Include Blank role (needs 6+ players)</label></div>' +
      "<fieldset><legend>Difficulty</legend>" +
      diffs.map(function (d) {
        return '<label><input type="radio" name="f-diff" value="' + d[0] + '"' +
          (cfg.difficulty === d[0] ? " checked" : "") + "> " + d[1] + "</label>";
      }).join("") + "</fieldset>" +
      '<p class="muted" id="role-preview"></p>' +
      '<button id="b-start">Start round</button></div>';
    root.innerHTML = h;

    var count = document.getElementById("f-count");
    var blank = document.getElementById("f-blank");
    function preview() {
      var n = Math.max(4, Math.min(12, parseInt(count.value, 10) || 5));
      var c = roleCounts(n, blank.checked);
      document.getElementById("role-preview").textContent =
        n + " players: " + c.civilians + " civilian(s), " + c.impostors +
        " impostor(s)" + (c.blank ? ", 1 blank" : "") + ".";
    }
    count.oninput = preview; blank.onchange = preview; preview();

    document.getElementById("b-start").onclick = function () {
      var n = Math.max(4, Math.min(12, parseInt(count.value, 10) || 5));
      var names = document.getElementById("f-names").value.split(",").map(function (s) { return s.trim(); });
      var diff = "ALL";
      var radios = document.getElementsByName("f-diff");
      for (var i = 0; i < radios.length; i++) if (radios[i].checked) diff = radios[i].value;
      S.config = {
        playerCount: n,
        mode: document.getElementById("f-mode").value,
        blank: document.getElementById("f-blank").checked,
        difficulty: diff
      };
      // Fresh table when the count changes; otherwise keep session scores.
      if (S.players.length !== n) {
        S.players = [];
        for (var k = 0; k < n; k++) S.players.push({ name: "", role: "civilian", alive: true, score: 0 });
      }
      for (var j = 0; j < n; j++) S.players[j].name = names[j] || "";
      startRound();
    };
  }

  // FR3: pass-and-play reveal flow
  function vReveal() {
    var i = S.revealIndex;
    var n = S.players.length;
    if (i >= n) { S.phase = "clues"; return render(); }
    var name = playerLabel(i);
    var h;
    if (!S.revealOpen) {
      h = '<div class="card center"><h2>Pass to ' + esc(name) + "</h2>" +
        "<p>Player " + (i + 1) + " of " + n + ". No peeking, everyone else look away.</p>" +
        '<button id="b-show">Tap to reveal my word</button></div>';
      root.innerHTML = h;
      document.getElementById("b-show").onclick = function () { S.revealOpen = true; render(); };
    } else {
      var card = cardFor(S.players[i].role, S.word);
      var sub = S.players[i].role === "impostor" && S.config.mode === "single"
        ? "You are the IMPOSTOR. You only get the category."
        : (S.players[i].role === "blank" ? "You are the BLANK. You know nothing." : "Keep a straight face.");
      h = '<div class="card center"><h2>' + esc(name) + "</h2>" +
        '<div class="big-word">' + esc(card) + "</div>" +
        '<p class="muted">' + esc(sub) + "</p>" +
        '<button id="b-hide">Tap to hide, pass it on</button></div>';
      root.innerHTML = h;
      document.getElementById("b-hide").onclick = function () {
        S.revealOpen = false;
        S.revealIndex++;
        render();
      };
    }
  }

  // FR4: clue phase
  function vClues() {
    var last = S.clueRound >= S.maxRounds;
    var h = '<div class="card"><h2>Clue round ' + S.clueRound + " of " + S.maxRounds + "</h2>" +
      "<p>Starting player: <strong>" + esc(playerLabel(S.starter)) + "</strong>. Go clockwise.</p>" +
      '<div class="rules"><p><strong>Rules:</strong> one word per clue. Never say your word (or the category, if you only got one).</p></div>' +
      '<div class="timer" id="t-left">' + S.timerLeft + 's</div>' +
      '<button id="b-timer" class="secondary">Start 15s timer</button>' +
      (last
        ? '<button id="b-vote">Go to vote</button>'
        : '<button id="b-next">Next clue round</button>') +
      '<p class="muted center">Discussion afterwards: about ' + DISCUSS_MIN + "&ndash;" + DISCUSS_MAX + "s.</p></div>";
    root.innerHTML = h;

    var btn = document.getElementById("b-timer");
    var el = document.getElementById("t-left");
    function armStart() {
      btn.disabled = false;
      btn.textContent = "Start 15s timer";
      btn.onclick = onStart;
    }
    function onStart() {
      stopTimer();
      S.timerLeft = CLUE_SECONDS;
      if (el) el.textContent = CLUE_SECONDS + "s";
      btn.textContent = "Reset timer";
      btn.onclick = onReset;
      S.timerId = setInterval(function () {
        S.timerLeft--;
        if (el) el.textContent = Math.max(0, S.timerLeft) + "s";
        if (S.timerLeft <= 0) {
          stopTimer();
          S.timerLeft = CLUE_SECONDS;
          armStart();
        }
      }, 1000);
    }
    function onReset() {
      stopTimer();
      S.timerLeft = CLUE_SECONDS;
      if (el) el.textContent = CLUE_SECONDS + "s";
      armStart();
    }
    armStart();

    if (last) {
      document.getElementById("b-vote").onclick = function () { S.phase = "vote"; S.revoted = false; render(); };
    } else {
      document.getElementById("b-next").onclick = function () { S.clueRound++; S.timerLeft = CLUE_SECONDS; render(); };
    }
  }

  function aliveOptions(selected) {
    return S.players.map(function (p, i) {
      if (!p.alive) return "";
      return '<option value="' + i + '"' + (i === selected ? " selected" : "") + ">" +
        esc(playerLabel(i)) + "</option>";
    }).join("");
  }

  // FR5: vote phase (host picks; ties get one revote, then an extra clue round)
  function vVote() {
    var h = '<div class="card"><h2>Vote</h2>' +
      "<p>Discuss, then vote. Host: pick who is eliminated" +
      (S.revoted ? " (revote after the tie)" : "") + ".</p>" +
      '<label for="f-elim">Eliminated player</label><select id="f-elim">' +
      aliveOptions(S.pendingElim >= 0 ? S.pendingElim : 0) + "</select>" +
      '<button id="b-elim">Reveal their role</button>' +
      '<button id="b-tie" class="secondary">Vote was tied</button></div>';
    root.innerHTML = h;
    document.getElementById("b-elim").onclick = function () {
      S.pendingElim = parseInt(document.getElementById("f-elim").value, 10);
      eliminate(S.pendingElim);
    };
    document.getElementById("b-tie").onclick = function () {
      if (!S.revoted) {
        // One revote.
        S.revoted = true;
        render();
      } else {
        // Still tied: nobody is eliminated, play another clue round.
        S.revoted = false;
        S.maxRounds++;
        S.phase = "clues";
        render();
      }
    };
  }

  function eliminate(idx) {
    S.players[idx].alive = false;
    S.eliminated.push(idx);
    var role = S.players[idx].role;
    if (role === "impostor" || role === "blank") {
      // Final-guess flow (FR5): host verifies the guess against the civilian word.
      S.guessFor = idx;
      S.phase = "guess";
    } else {
      var win = checkWin();
      if (win) return finishRound(win, { guessCorrect: false });
      // No decision yet: another clue round, then vote again.
      S.maxRounds++;
      S.phase = "clues";
    }
    render();
  }

  // Final-guess prompt for an eliminated impostor or blank.
  function vGuess() {
    var p = S.players[S.guessFor];
    var isBlank = p.role === "blank";
    var h = '<div class="card"><h2>' + esc(playerLabel(S.guessFor)) +
      " was " + (isBlank ? "the BLANK" : "an IMPOSTOR") + "</h2>" +
      "<p>Final guess: they may now guess the secret word. " +
      (isBlank ? "A correct guess wins the game for the Blank." : "A correct guess steals the win for the Impostors.") +
      ' (Host: the secret word is <strong>"' + esc(S.word.civilian) + '"</strong>.)</p>' +
      '<label for="f-first">Who first called out this ' + (isBlank ? "blank" : "impostor") +
      "? (civilian bonus +1)</label>" +
      '<select id="f-first"><option value="-1">Nobody / skip</option>' +
      S.players.map(function (q, i) {
        if (q.role !== "civilian") return "";
        return '<option value="' + i + '">' + esc(playerLabel(i)) + "</option>";
      }).join("") + "</select>" +
      '<button id="b-right">Guess CORRECT</button>' +
      '<button id="b-wrong" class="secondary">Guess WRONG</button></div>';
    root.innerHTML = h;
    document.getElementById("b-right").onclick = function () {
      var first = parseInt(document.getElementById("f-first").value, 10);
      if (isBlank) {
        finishRound({ winner: "blank", reason: "The Blank guessed the secret word." }, { guessCorrect: true, guessBy: "blank", firstVoter: first });
      } else {
        finishRound({ winner: "impostors", reason: "The eliminated impostor guessed the secret word." }, { guessCorrect: true, guessBy: "impostor", firstVoter: first });
      }
    };
    document.getElementById("b-wrong").onclick = function () {
      var first = parseInt(document.getElementById("f-first").value, 10);
      var win = checkWin(); // all impostors out -> civilians win; otherwise continue
      if (win) { finishRound(win, { guessCorrect: false, firstVoter: first }); return; }
      S.maxRounds++;
      S.revoted = false;
      S.phase = "clues";
      // Remember the bonus nominee for round end (stored on the side).
      S.pendingBonus = first;
      render();
    };
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

  function scoreTable() {
    var rows = S.players.map(function (p, i) {
      var roleTag = p.alive ? "" : " (out)";
      return "<tr><td>" + esc(playerLabel(i)) + esc(roleTag) + "</td><td>" + p.score + "</td></tr>";
    }).join("");
    return '<table><tr><th>Player</th><th>Points</th></tr>' + rows + "</table>";
  }

  // FR8: round end
  function vResult() {
    var r = S.result;
    var title = r.winner === "civilians" ? "Civilians win!"
      : r.winner === "impostors" ? "Impostors win!"
      : "Blank wins!";
    var wordsLine = S.config.mode === "pair"
      ? 'Civilians: "' + S.word.civilian + '" / Impostor: "' + S.word.impostor + '" (' + S.word.theme + ")."
      : 'Word: "' + S.word.civilian + '" (' + S.word.theme + ").";
    var h = '<div class="card"><h2>' + title + "</h2>" +
      "<p>" + esc(r.reason) + "</p>" +
      "<p>" + esc(wordsLine) + "</p>" +
      scoreTable() +
      '<button id="b-next-round">Next round</button>' +
      '<button id="b-end" class="secondary">End game</button></div>';
    root.innerHTML = h;
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
    root.innerHTML = '<div class="card"><h2>Final scores</h2>' +
      '<table><tr><th>Player</th><th>Points</th></tr>' + rows + "</table>" +
      '<button id="b-again">Play again</button>' +
      '<button id="b-setup" class="secondary">Change setup</button></div>';
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
      root.innerHTML = '<div class="card"><h2>Could not load words</h2>' +
        "<p>Serve the <code>dist/</code> folder over HTTP (for example " +
        "<code>npx serve dist</code>) or deploy with Firebase Hosting, then reload.</p></div>";
    });
})();
