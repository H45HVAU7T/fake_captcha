/* =============================================================================
   EdgeGate — themed verification flow for auditorium check-in
   Pure vanilla JS. No dependencies. Everything is a single state machine
   driven by STATE.step, with one render pass whenever the step changes.
   ============================================================================= */

(() => {
  "use strict";

  /* ---------------------------------------------------------------------
     CONFIG — tweak these to retune puzzle difficulty / timings
     --------------------------------------------------------------------- */
  const CONFIG = {
    // Step 2 slider/jigsaw
    PUZZLE_TARGET_RATIO: 0.62,   // where the notch sits, as a fraction of frame width (0-1)
    PUZZLE_TOLERANCE_PX: 10,     // how close the piece must land to the notch to "snap"
    PUZZLE_PIECE_SIZE: 44,       // must match .puzzle-piece / .puzzle-notch width in CSS

    // Step 3 grid puzzle — minimum correct anomaly tiles the user must pick
    GRID_REQUIRED_CORRECT: 3,

    // Step 4 fake loader
    LOADER_TARGET_PCT: 92,       // loader climbs to this, never quite hits 100 on its own
    LOADER_FINAL_JUMP_MS: 550,   // after target reached, short pause then jump to 100%
    LOADER_TICK_MS: 90,          // how often the progress ring updates
    LOADER_LOG_INTERVAL_MS: 620, // how often a new fake log line appears

    // localStorage key for resuming progress if the page reloads mid-flow
    STORAGE_KEY: "edgegate_verify_progress_v1",
  };

  // Fake telemetry copy shown in the step-4 console. Order matters loosely —
  // "early" lines first, "closing" lines last — but the exact set can be edited freely.
  const LOG_LINES = [
    "Requesting attestation token…",
    "Session fingerprint matched",
    "Synchronizing key fragments…",
    "Verifying room quorum (1/3)",
    "Verifying room quorum (2/3)",
    "Verifying room quorum (3/3)",
    "Cross-checking device signal",
    "Aggregating peer confirmations…",
    "Establishing secure channel",
    "Provisioning stage access token",
  ];

  // Grid tile copy for Step 3. `anomaly:true` tiles are the "correct" picks.
  // Each tile renders a visible icon + caption (not just an aria-label) so
  // people can actually tell tiles apart and judge which are red flags.
  // TEAM NOTE: swap `pattern` for a real image class/URL per tile when art is ready;
  // the icon/caption can stay as an overlay on top of a real screenshot if you want.
  const TILE_DATA = [
    { label: "Urgent: reset your password now", anomaly: true,  pattern: "pattern-1", icon: "alert" },
    { label: "Company logo",                     anomaly: false, pattern: "pattern-2", icon: "brand" },
    { label: "Sender: support@paypaI.com",       anomaly: true,  pattern: "pattern-3", icon: "at" },
    { label: "Calendar invite",                  anomaly: false, pattern: "pattern-4", icon: "calendar" },
    { label: "bit.ly/3xK9z2 — click now",        anomaly: true,  pattern: "pattern-5", icon: "link" },
    { label: "Team meeting note",                anomaly: false, pattern: "pattern-6", icon: "note" },
    { label: "\"Dear user\" + account will close", anomaly: true, pattern: "pattern-7", icon: "warning" },
    { label: "Monthly newsletter",               anomaly: false, pattern: "pattern-8", icon: "mail" },
    { label: "Login page asking for full SSN",   anomaly: true,  pattern: "pattern-9", icon: "shield-x" },
  ];

  // Minimal inline icon set (no external assets, keeps bundle tiny).
  // Each returns an SVG string sized by the .tile-icon wrapper in CSS.
  const ICONS = {
    alert: '<path d="M12 3L2 20h20L12 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="17" r="1" fill="currentColor"/>',
    brand: '<rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    at: '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M16 12v1.5a2.5 2.5 0 005 0V12a9 9 0 10-4 7.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    link: '<path d="M9 15l6-6M8 16l-2 2a3.5 3.5 0 01-5-5l3-3a3.5 3.5 0 015 0M16 8l2-2a3.5 3.5 0 015 5l-3 3a3.5 3.5 0 01-5 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    note: '<rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    warning: '<path d="M12 3L2 20h20L12 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="17" r="1" fill="currentColor"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 6.5l8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    "shield-x": '<path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  };

  const STEPS = ["intro", "slider", "grid", "loading", "success"];

  /* ---------------------------------------------------------------------
     STATE
     --------------------------------------------------------------------- */
  const state = {
    step: "intro",
    sliderSolved: false,
    gridSelected: new Set(),
    startTime: null,
  };

  /* ---------------------------------------------------------------------
     DOM refs
     --------------------------------------------------------------------- */
  const el = {
    statusLine: document.getElementById("statusLine"),
    sessionId: document.getElementById("sessionId"),
    dots: document.querySelectorAll(".dot"),

    // step 1
    humanCheck: document.getElementById("humanCheck"),
    btnStartVerify: document.getElementById("btnStartVerify"),

    // step 2
    puzzleFrame: document.getElementById("puzzleFrame"),
    puzzleNotch: document.getElementById("puzzleNotch"),
    puzzlePiece: document.getElementById("puzzlePiece"),
    sliderTrack: document.getElementById("sliderTrack"),
    sliderFill: document.getElementById("sliderFill"),
    sliderHandle: document.getElementById("sliderHandle"),
    sliderLabel: document.getElementById("sliderLabel"),
    sliderHint: document.getElementById("sliderHint"),

    // step 3
    grid3: document.getElementById("grid3"),
    btnConfirmGrid: document.getElementById("btnConfirmGrid"),
    gridHint: document.getElementById("gridHint"),

    // step 4
    ringFg: document.getElementById("ringFg"),
    ringPct: document.getElementById("ringPct"),
    loaderStatus: document.getElementById("loaderStatus"),
    logConsole: document.getElementById("logConsole"),

    // step 5
    verifyTime: document.getElementById("verifyTime"),
    tokenId: document.getElementById("tokenId"),
  };

  /* ---------------------------------------------------------------------
     UTIL
     --------------------------------------------------------------------- */
  const randHex = (len) =>
    Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join("").toUpperCase();

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  function saveProgress() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({ step: state.step }));
    } catch (e) {
      /* localStorage may be unavailable (private mode / storage full) — fail silently,
         the flow still works in-memory for this page view */
    }
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (STEPS.includes(parsed.step)) return parsed.step;
    } catch (e) {
      /* corrupted cache — ignore and start fresh */
    }
    return null;
  }

  function clearProgress() {
    try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------------
     STATE MACHINE — goTo() is the single entry point for changing steps
     --------------------------------------------------------------------- */
  function goTo(step) {
    state.step = step;
    saveProgress();
    render();

    // Side effects that should fire exactly once on entering a step
    if (step === "loading") runLoader();
    if (step === "success") finishSuccess();
  }

  function render() {
    STEPS.forEach((name) => {
      const section = document.getElementById(`step-${name}`);
      section.hidden = name !== state.step;
    });

    el.dots.forEach((dot) => {
      const name = dot.dataset.dot;
      const idx = STEPS.indexOf(name);
      const curIdx = STEPS.indexOf(state.step);
      dot.classList.toggle("active", name === state.step);
      dot.classList.toggle("done", idx < curIdx);
    });

    const statusByStep = {
      intro: "Attestation service",
      slider: "Solving challenge…",
      grid: "Solving challenge…",
      loading: "Aggregating signals…",
      success: "Verified",
    };
    el.statusLine.textContent = statusByStep[state.step];
  }

  /* =======================================================================
     STEP 1 — intro
     ======================================================================= */
  function initStep1() {
    el.sessionId.textContent = randHex(8);

    el.humanCheck.addEventListener("change", () => {
      el.btnStartVerify.disabled = !el.humanCheck.checked;
    });

    el.btnStartVerify.addEventListener("click", () => {
      state.startTime = performance.now();
      goTo("slider");
    });
  }

  /* =======================================================================
     STEP 2 — slider / jigsaw puzzle
     Piece position is driven purely by the slider handle's drag fraction
     (0..1). At fraction == PUZZLE_TARGET_RATIO (within tolerance) it snaps.
     ======================================================================= */
  function initStep2() {
    let dragging = false;
    let trackWidth = 0;
    let handleWidth = 0;
    let frameWidth = 0;
    let maxHandleTravel = 0;

    function measure() {
      trackWidth = el.sliderTrack.clientWidth;
      handleWidth = el.sliderHandle.offsetWidth;
      maxHandleTravel = trackWidth - handleWidth - 4; // 4 = 2px inset each side
      frameWidth = el.puzzleFrame.clientWidth;

      // Position the notch at the target ratio (minus half piece width to center it)
      const notchLeft = frameWidth * CONFIG.PUZZLE_TARGET_RATIO - CONFIG.PUZZLE_PIECE_SIZE / 2;
      el.puzzleNotch.style.left = `${notchLeft}px`;
    }

    function setFraction(fraction) {
      fraction = clamp(fraction, 0, 1);
      const handleX = fraction * maxHandleTravel;
      el.sliderHandle.style.transform = `translateX(${handleX}px)`;
      el.sliderFill.style.width = `${(handleX + handleWidth / 2) / trackWidth * 100}%`;
      el.sliderHandle.setAttribute("aria-valuenow", Math.round(fraction * 100));

      // Piece travels across the puzzle frame using the same fraction, so
      // dragging the handle all the way right moves the piece all the way right.
      const pieceMaxTravel = frameWidth - CONFIG.PUZZLE_PIECE_SIZE;
      const pieceX = fraction * pieceMaxTravel;
      el.puzzlePiece.style.transform = `translateX(${pieceX}px)`;

      el.sliderLabel.style.opacity = fraction > 0.08 ? "0" : "1";

      return pieceX;
    }

    function checkSnap(fraction) {
      const pieceMaxTravel = frameWidth - CONFIG.PUZZLE_PIECE_SIZE;
      const pieceX = fraction * pieceMaxTravel;
      const notchX = frameWidth * CONFIG.PUZZLE_TARGET_RATIO - CONFIG.PUZZLE_PIECE_SIZE / 2;

      if (Math.abs(pieceX - notchX) <= CONFIG.PUZZLE_TOLERANCE_PX) {
        // Snap exactly into place for a satisfying "locked in" feel
        const snapFraction = notchX / pieceMaxTravel;
        setFraction(snapFraction);
        solveSlider();
        return true;
      }
      return false;
    }

    function solveSlider() {
      if (state.sliderSolved) return;
      state.sliderSolved = true;
      el.sliderHint.textContent = "Fragment aligned";
      el.sliderHint.className = "hint-msg ok";
      el.puzzlePiece.style.boxShadow = "0 0 0 2px var(--success), 0 6px 16px -4px rgba(0,0,0,0.5)";
      el.sliderHandle.setAttribute("aria-disabled", "true");
      setTimeout(() => goTo("grid"), 550);
    }

    function onPointerMove(clientX) {
      const trackRect = el.sliderTrack.getBoundingClientRect();
      const fraction = (clientX - trackRect.left - handleWidth / 2) / maxHandleTravel;
      const pieceX = setFraction(fraction);
      return { fraction: clamp(fraction, 0, 1) };
    }

    function onDragEnd(fraction) {
      dragging = false;
      el.sliderHandle.classList.remove("dragging");
      if (state.sliderSolved) return;
      const snapped = checkSnap(fraction);
      if (!snapped) {
        // Miss — spring back to start and let them try again
        setFraction(0);
        el.sliderHint.textContent = "Not quite — try again";
        el.sliderHint.className = "hint-msg error";
      }
    }

    // Pointer events cover touch + mouse in one handler set (touch-action:none in CSS
    // stops the browser from scrolling the page while dragging on mobile)
    el.sliderHandle.addEventListener("pointerdown", (e) => {
      if (state.sliderSolved) return;
      dragging = true;
      measure();
      el.sliderHandle.classList.add("dragging");
      el.sliderHandle.setPointerCapture(e.pointerId);
    });

    el.sliderHandle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      onPointerMove(e.clientX);
    });

    el.sliderHandle.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      const { fraction } = onPointerMove(e.clientX);
      onDragEnd(fraction);
    });

    el.sliderHandle.addEventListener("pointercancel", () => {
      if (!dragging) return;
      onDragEnd(0);
    });

    // Keyboard access: arrow keys nudge the slider for non-touch users
    el.sliderHandle.addEventListener("keydown", (e) => {
      if (state.sliderSolved) return;
      measure();
      const current = Number(el.sliderHandle.getAttribute("aria-valuenow")) / 100;
      let next = current;
      if (e.key === "ArrowRight") next = current + 0.04;
      else if (e.key === "ArrowLeft") next = current - 0.04;
      else return;
      e.preventDefault();
      setFraction(next);
      checkSnap(clamp(next, 0, 1));
    });

    window.addEventListener("resize", measure);

    // Initial measure needs layout to exist; run once section becomes visible
    const observer = new MutationObserver(() => {
      if (!el.puzzleFrame.closest("section").hidden) {
        measure();
        observer.disconnect();
      }
    });
    observer.observe(document.getElementById("step-slider"), { attributes: true, attributeFilter: ["hidden"] });
  }

  /* =======================================================================
     STEP 3 — 3x3 anomaly grid
     ======================================================================= */
  function initStep3() {
    TILE_DATA.forEach((tile, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tile";
      btn.dataset.index = String(i);
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", tile.label);
      btn.innerHTML = `
        <span class="tile-art ${tile.pattern}">
          <svg class="tile-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[tile.icon] || ""}</svg>
        </span>
        <span class="tile-caption">${tile.label}</span>
        <span class="tile-check">&#10003;</span>
      `;
      btn.addEventListener("click", () => toggleTile(i, btn));
      el.grid3.appendChild(btn);
    });

    el.btnConfirmGrid.addEventListener("click", confirmGrid);
  }

  function toggleTile(index, btn) {
    if (state.gridSelected.has(index)) {
      state.gridSelected.delete(index);
      btn.classList.remove("selected");
      btn.setAttribute("aria-pressed", "false");
    } else {
      state.gridSelected.add(index);
      btn.classList.add("selected");
      btn.setAttribute("aria-pressed", "true");
    }
    el.btnConfirmGrid.disabled = state.gridSelected.size === 0;
    el.gridHint.textContent = "";
    el.gridHint.className = "hint-msg";
  }

  function confirmGrid() {
    const correctCount = TILE_DATA.filter((t, i) => t.anomaly && state.gridSelected.has(i)).length;
    const wrongCount = [...state.gridSelected].filter((i) => !TILE_DATA[i].anomaly).length;

    if (correctCount >= CONFIG.GRID_REQUIRED_CORRECT && wrongCount === 0) {
      el.gridHint.textContent = "Selection confirmed";
      el.gridHint.className = "hint-msg ok";
      el.btnConfirmGrid.disabled = true;
      setTimeout(() => goTo("loading"), 450);
    } else {
      el.gridHint.textContent = "That's not quite right — check again";
      el.gridHint.className = "hint-msg error";
    }
  }

  /* =======================================================================
     STEP 4 — fake progress loader
     Climbs smoothly to LOADER_TARGET_PCT with easing (fast start, slow
     crawl near the target — the classic "almost done" captcha feeling),
     then pauses briefly and jumps to 100% before advancing.
     ======================================================================= */
  const RING_CIRCUMFERENCE = 2 * Math.PI * 44; // matches r=44 in the SVG

  function setRingProgress(pct) {
    const offset = RING_CIRCUMFERENCE * (1 - pct / 100);
    el.ringFg.style.strokeDashoffset = String(offset);
    el.ringPct.textContent = `${Math.round(pct)}%`;
  }

  function appendLogLine(text, isOk) {
    const line = document.createElement("div");
    line.className = "log-line";
    line.innerHTML = isOk ? `<span class="ok">✓</span> ${text}` : text;
    el.logConsole.appendChild(line);
    // Keep only the last few lines rendered — this is a small fixed-height console,
    // not a full history, so trim aggressively to avoid layout growth.
    while (el.logConsole.children.length > 5) {
      el.logConsole.removeChild(el.logConsole.firstChild);
    }
  }

  function runLoader() {
    // Reset UI in case this step is re-entered
    el.logConsole.innerHTML = "";
    setRingProgress(0);
    el.loaderStatus.textContent = "Initializing…";

    let pct = 0;
    let logIndex = 0;
    const target = CONFIG.LOADER_TARGET_PCT;

    const tick = setInterval(() => {
      // Ease-out: bigger steps early, tiny steps as we approach target
      const remaining = target - pct;
      const step = Math.max(0.4, remaining * 0.045);
      pct = Math.min(target, pct + step);
      setRingProgress(pct);

      if (pct >= target) {
        clearInterval(tick);
        el.loaderStatus.textContent = "Quorum reached";
        setTimeout(() => {
          setRingProgress(100);
          appendLogLine("Verification complete", true);
          setTimeout(() => goTo("success"), CONFIG.LOADER_FINAL_JUMP_MS);
        }, 350);
      }
    }, CONFIG.LOADER_TICK_MS);

    const logTick = setInterval(() => {
      if (logIndex >= LOG_LINES.length || pct >= target) {
        clearInterval(logTick);
        return;
      }
      appendLogLine(LOG_LINES[logIndex]);
      logIndex += 1;
      if (logIndex <= 3) el.loaderStatus.textContent = LOG_LINES[logIndex - 1];
      else el.loaderStatus.textContent = "Synchronizing key fragments…";
    }, CONFIG.LOADER_LOG_INTERVAL_MS);
  }

  /* =======================================================================
     STEP 5 — success
     ======================================================================= */
  function finishSuccess() {
    const elapsedMs = state.startTime ? performance.now() - state.startTime : 0;
    el.verifyTime.textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
    el.tokenId.textContent = randHex(10);
    clearProgress(); // flow is complete — don't resume into a stale step on reload
  }

  /* ---------------------------------------------------------------------
     BOOT
     --------------------------------------------------------------------- */
  function boot() {
    initStep1();
    initStep2();
    initStep3();

    // Resume mid-flow if the page was reloaded (e.g. phone locked mid-scan).
    // We only resume as far as "grid" — loading/success always restart clean
    // so the animated bits don't try to resume half-played.
    const resumed = loadProgress();
    if (resumed && resumed !== "loading" && resumed !== "success" && resumed !== "intro") {
      state.step = resumed;
    }
    render();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();