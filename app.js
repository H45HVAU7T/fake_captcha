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
    PUZZLE_TARGET_MIN: 0.30,
    PUZZLE_TARGET_MAX: 0.82,
    PUZZLE_TOLERANCE_PX: 14,     // how close the piece must land to the notch to "snap"
    PUZZLE_PIECE_SIZE: 44,       // must match .puzzle-piece / .puzzle-notch width in CSS

    // Step 4 grid puzzle — minimum correct anomaly tiles the user must pick
    GRID_REQUIRED_CORRECT: 3,

    // Step 6 fake loader
    LOADER_TARGET_PCT: 92,       // loader climbs to this, never quite hits 100 on its own
    LOADER_FINAL_JUMP_MS: 550,   // after target reached, short pause then jump to 100%
    LOADER_TICK_MS: 90,          // how often the progress ring updates
    LOADER_LOG_INTERVAL_MS: 620, // how often a new fake log line appears

    // localStorage key for resuming progress if the page reloads mid-flow
    STORAGE_KEY: "edgegate_verify_progress_v1",
  };

  // Fake telemetry copy shown in the step-6 console.
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

  // Grid tile copy for Step 4. `anomaly:true` tiles are the "correct" picks.
  const TILE_DATA = [
    { label: "Urgent: Reset password now",   anomaly: true,  pattern: "pattern-1", icon: "alert" },
    { label: "Official company logo",        anomaly: false, pattern: "pattern-2", icon: "brand" },
    { label: "From: support@paypaI.com",     anomaly: true,  pattern: "pattern-3", icon: "at" },
    { label: "Team calendar invite",         anomaly: false, pattern: "pattern-4", icon: "calendar" },
    { label: "bit.ly/3xK9z2 — click now",    anomaly: true,  pattern: "pattern-5", icon: "link" },
    { label: "Conference meeting note",      anomaly: false, pattern: "pattern-6", icon: "note" },
    { label: "Suspicious invoice .exe",      anomaly: true,  pattern: "pattern-7", icon: "warning" },
    { label: "Monthly team newsletter",      anomaly: false, pattern: "pattern-8", icon: "mail" },
    { label: "Form asking for full SSN",     anomaly: true,  pattern: "pattern-9", icon: "shield-x" },
  ];

  // Minimal inline icon set
  const ICONS = {
    alert: '<path d="M12 3L2 20h20L12 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/>',
    brand: '<rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    at: '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 12v1.5a2.5 2.5 0 005 0V12a9 9 0 10-4 7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    link: '<path d="M9 15l6-6M8 16l-2 2a3.5 3.5 0 01-5-5l3-3a3.5 3.5 0 015 0M16 8l2-2a3.5 3.5 0 015 5l-3 3a3.5 3.5 0 01-5 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    note: '<rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    warning: '<path d="M12 3L2 20h20L12 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 6.5l8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    "shield-x": '<path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  };

  const STEPS = ["intro", "captcha", "slider", "grid", "robot", "loading", "success"];

  /* ---------------------------------------------------------------------
     STATE
     --------------------------------------------------------------------- */
  const state = {
    step: "intro",
    captchaCode: "",
    captchaSolved: false,
    sliderSolved: false,
    gridSelected: new Set(),
    robotSolved: false,
    robotVerifying: false,
    startTime: null,
  };

  const session = {
    puzzleTargetRatio: 0.5, // randomized in boot()
    tiles: [],              // shuffled copy of TILE_DATA
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

    // step 2 (regular captcha)
    captchaCard: document.querySelector(".captcha-card"),
    captchaCanvas: document.getElementById("captchaCanvas"),
    btnRefreshCaptcha: document.getElementById("btnRefreshCaptcha"),
    btnAudioCaptcha: document.getElementById("btnAudioCaptcha"),
    captchaInput: document.getElementById("captchaInput"),
    btnVerifyCaptcha: document.getElementById("btnVerifyCaptcha"),
    captchaHint: document.getElementById("captchaHint"),

    // step 3 (slider jigsaw)
    puzzleFrame: document.getElementById("puzzleFrame"),
    puzzleNotch: document.getElementById("puzzleNotch"),
    puzzlePiece: document.getElementById("puzzlePiece"),
    sliderTrack: document.getElementById("sliderTrack"),
    sliderFill: document.getElementById("sliderFill"),
    sliderHandle: document.getElementById("sliderHandle"),
    sliderLabel: document.getElementById("sliderLabel"),
    sliderHint: document.getElementById("sliderHint"),

    // step 4 (grid)
    grid3: document.getElementById("grid3"),
    btnConfirmGrid: document.getElementById("btnConfirmGrid"),
    gridHint: document.getElementById("gridHint"),

    // step 5 (robot check)
    robotCard: document.getElementById("robotCard"),
    robotWidget: document.getElementById("robotWidget"),
    robotCheckbox: document.getElementById("robotCheckbox"),
    robotSpinner: document.getElementById("robotSpinner"),
    robotCheckIcon: document.getElementById("robotCheckIcon"),
    robotLabel: document.getElementById("robotLabel"),
    btnConfirmRobot: document.getElementById("btnConfirmRobot"),
    robotHint: document.getElementById("robotHint"),

    // step 6 (loader)
    ringFg: document.getElementById("ringFg"),
    ringPct: document.getElementById("ringPct"),
    loaderStatus: document.getElementById("loaderStatus"),
    logConsole: document.getElementById("logConsole"),

    // step 7 (success)
    verifyTime: document.getElementById("verifyTime"),
    tokenId: document.getElementById("tokenId"),
  };

  /* ---------------------------------------------------------------------
     UTIL
     --------------------------------------------------------------------- */
  const randHex = (len) =>
    Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join("").toUpperCase();

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const randRange = (min, max) => min + Math.random() * (max - min);

  function shuffleArray(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function saveProgress() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({ step: state.step }));
    } catch (e) {
      /* localStorage may be unavailable */
    }
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (STEPS.includes(parsed.step)) return parsed.step;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function clearProgress() {
    try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch (e) {}
  }

  /* ---------------------------------------------------------------------
     STATE MACHINE
     --------------------------------------------------------------------- */
  function goTo(step) {
    state.step = step;
    saveProgress();
    render();

    if (step === "captcha") {
      generateCaptcha();
      setTimeout(() => el.captchaInput?.focus(), 80);
    }
    if (step === "loading") runLoader();
    if (step === "success") finishSuccess();
  }

  function render() {
    STEPS.forEach((name) => {
      const section = document.getElementById(`step-${name}`);
      if (section) section.hidden = name !== state.step;
    });

    if (el.dots) {
      el.dots.forEach((dot) => {
        const name = dot.dataset.dot;
        const idx = STEPS.indexOf(name);
        const curIdx = STEPS.indexOf(state.step);
        dot.classList.toggle("active", name === state.step);
        dot.classList.toggle("done", idx < curIdx);
      });
    }

    const statusByStep = {
      intro: "Attestation service",
      captcha: "Solving challenge (1/4)…",
      slider: "Solving challenge (2/4)…",
      grid: "Solving challenge (3/4)…",
      robot: "Solving challenge (4/4)…",
      loading: "Aggregating signals…",
      success: "Verified",
    };
    if (el.statusLine) {
      el.statusLine.textContent = statusByStep[state.step] || "Security Check";
    }
  }

  /* =======================================================================
     STEP 1 — Checkbox Intro
     ======================================================================= */
  function initStep1() {
    if (!el.humanCheck) return;

    el.humanCheck.addEventListener("change", () => {
      if (el.humanCheck.checked) {
        state.startTime = performance.now();

        // Show realistic spinner inside checkbox
        if (el.rcCheckboxVisual) el.rcCheckboxVisual.classList.add("loading");

    el.btnStartVerify.addEventListener("click", () => {
      state.startTime = performance.now();
      goTo("captcha");
    });
  }

  /* =======================================================================
     STEP 2 — regular text captcha
     Generates a distorted alphanumeric code rendered on a high-DPI canvas
     with random noise, wavy lines, rotations, and audio accessibility.
     ======================================================================= */
  const CAPTCHA_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // exclude 0, O, 1, I for clarity
  const CAPTCHA_COLORS = [
    "#5b7cfa", "#38bdf8", "#34d399", "#a78bfa",
    "#f472b6", "#fbbf24", "#e2e8f0", "#818cf8"
  ];
  const FONTS = [
    "bold 32px 'Segoe UI', sans-serif",
    "bold italic 33px 'Arial', sans-serif",
    "bold 34px 'Trebuchet MS', sans-serif",
    "bold italic 32px 'Verdana', sans-serif",
    "bold 33px 'Helvetica Neue', sans-serif"
  ];

  function generateCaptcha() {
    // Pick 5 random characters
    let code = "";
    for (let i = 0; i < 5; i++) {
      code += CAPTCHA_CHARS[Math.floor(Math.random() * CAPTCHA_CHARS.length)];
    }
    state.captchaCode = code;
    drawCaptcha(code);
  }

  function drawCaptcha(text) {
    const canvas = el.captchaCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // Match internal pixel resolution to rendered display
    const dpr = window.devicePixelRatio || 1;
    const width = 280;
    const height = 84;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Background fill
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, "#10141d");
    bgGrad.addColorStop(0.5, "#151a26");
    bgGrad.addColorStop(1, "#0d1117");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Subtle background grid
    ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    for (let x = 14; x < width; x += 18) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 14; y < height; y += 18) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Background noise curves
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = CAPTCHA_COLORS[Math.floor(Math.random() * CAPTCHA_COLORS.length)] + "33";
      ctx.lineWidth = randRange(1, 2.5);
      ctx.beginPath();
      ctx.moveTo(0, randRange(10, height - 10));
      ctx.bezierCurveTo(
        randRange(40, 100), randRange(0, height),
        randRange(140, 220), randRange(0, height),
        width, randRange(10, height - 10)
      );
      ctx.stroke();
    }

    // Scatter background noise dots
    for (let i = 0; i < 45; i++) {
      ctx.fillStyle = CAPTCHA_COLORS[Math.floor(Math.random() * CAPTCHA_COLORS.length)] + "40";
      ctx.beginPath();
      ctx.arc(randRange(0, width), randRange(0, height), randRange(0.8, 2.2), 0, Math.PI * 2);
      ctx.fill();
    }

    // Render characters with distortion, rotation, and jitter
    const charCount = text.length;
    const spacing = (width - 60) / charCount;
    const startX = 32;

    for (let i = 0; i < charCount; i++) {
      const char = text[i];
      const charX = startX + i * spacing + randRange(-3, 3);
      const charY = height / 2 + randRange(-3, 4);
      const angle = randRange(-0.28, 0.28); // rotation in radians (~ -16deg to +16deg)
      const color = CAPTCHA_COLORS[Math.floor(Math.random() * CAPTCHA_COLORS.length)];
      const font = FONTS[Math.floor(Math.random() * FONTS.length)];

      ctx.save();
      ctx.translate(charX, charY);
      ctx.rotate(angle);

      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      // Soft glow shadow
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.fillStyle = color;
      ctx.fillText(char, 0, 0);

      // Core character fill
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#f1f5f9";
      ctx.fillText(char, 0, 0);

      ctx.restore();
    }

    // Foreground strike-through / distortion wavy lines
    for (let i = 0; i < 2; i++) {
      ctx.strokeStyle = CAPTCHA_COLORS[Math.floor(Math.random() * CAPTCHA_COLORS.length)] + "80";
      ctx.lineWidth = randRange(1.5, 2.2);
      ctx.beginPath();
      ctx.moveTo(randRange(5, 25), randRange(20, height - 20));
      ctx.bezierCurveTo(
        randRange(70, 110), randRange(10, height - 10),
        randRange(170, 210), randRange(10, height - 10),
        randRange(width - 25, width - 5), randRange(20, height - 20)
      );
      ctx.stroke();
    }
  }

  function playAudioCaptcha() {
    if (!("speechSynthesis" in window)) {
      el.captchaHint.textContent = "Audio speech is not supported in this browser";
      el.captchaHint.className = "hint-msg error";
      return;
    }

    window.speechSynthesis.cancel();
    // Spell characters distinctly with commas for clean pauses
    const letters = state.captchaCode.split("").join(", ");
    const utterance = new SpeechSynthesisUtterance(`Security code: ${letters}`);
    utterance.rate = 0.75;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }

  function verifyCaptcha() {
    if (state.captchaSolved) return;
    const entered = (el.captchaInput.value || "").trim().toUpperCase();

    if (entered === state.captchaCode) {
      state.captchaSolved = true;
      el.captchaHint.textContent = "Security code verified";
      el.captchaHint.className = "hint-msg ok";
      el.captchaInput.disabled = true;
      el.btnVerifyCaptcha.disabled = true;
      el.btnRefreshCaptcha.disabled = true;
      el.btnAudioCaptcha.disabled = true;
      setTimeout(() => goTo("slider"), 480);
    } else {
      el.captchaHint.textContent = "Incorrect code — please try again";
      el.captchaHint.className = "hint-msg error";
      if (el.captchaCard) {
        el.captchaCard.classList.remove("shake");
        void el.captchaCard.offsetWidth; // trigger reflow for animation restart
        el.captchaCard.classList.add("shake");
      }
      el.captchaInput.value = "";
      el.btnVerifyCaptcha.disabled = true;
      generateCaptcha();
      el.captchaInput.focus();
    }
  }

  function initStep2() {
    // Generate initial captcha code & canvas
    generateCaptcha();

    // Input events
    el.captchaInput.addEventListener("input", () => {
      const val = el.captchaInput.value.trim();
      el.btnVerifyCaptcha.disabled = val.length === 0;
      el.captchaHint.textContent = "";
      el.captchaHint.className = "hint-msg";
    });

    el.captchaInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !el.btnVerifyCaptcha.disabled) {
        e.preventDefault();
        verifyCaptcha();
      }
    });

    // Refresh button
    el.btnRefreshCaptcha.addEventListener("click", () => {
      if (state.captchaSolved) return;
      el.btnRefreshCaptcha.classList.add("spin");
      setTimeout(() => el.btnRefreshCaptcha.classList.remove("spin"), 450);
      generateCaptcha();
      el.captchaInput.value = "";
      el.btnVerifyCaptcha.disabled = true;
      el.captchaHint.textContent = "";
      el.captchaHint.className = "hint-msg";
      el.captchaInput.focus();
    });

    // Audio button
    el.btnAudioCaptcha.addEventListener("click", () => {
      playAudioCaptcha();
    });

    // Submit button
    el.btnVerifyCaptcha.addEventListener("click", verifyCaptcha);
  }

  /* =======================================================================
     STEP 3 — slider / jigsaw puzzle
     ======================================================================= */
  function initStep3() {
    let dragging = false;
    let trackWidth = 0;
    let handleWidth = 0;
    let frameWidth = 0;
    let maxHandleTravel = 0;

    function measure() {
      if (!el.sliderTrack || !el.puzzleFrame) return;
      trackWidth = el.sliderTrack.clientWidth;
      handleWidth = el.sliderHandle.offsetWidth;
      maxHandleTravel = trackWidth - handleWidth - 4;
      frameWidth = el.puzzleFrame.clientWidth;

      const notchLeft = frameWidth * session.puzzleTargetRatio - CONFIG.PUZZLE_PIECE_SIZE / 2;
      if (el.puzzleNotch) el.puzzleNotch.style.left = `${Math.max(0, notchLeft)}px`;
    }

    function setFraction(fraction) {
      fraction = clamp(fraction, 0, 1);
      const handleX = fraction * maxHandleTravel;
      el.sliderHandle.style.transform = `translateX(${handleX}px)`;
      if (el.sliderFill) el.sliderFill.style.width = `${(handleX + handleWidth / 2) / trackWidth * 100}%`;
      el.sliderHandle.setAttribute("aria-valuenow", Math.round(fraction * 100));

      const pieceMaxTravel = frameWidth - CONFIG.PUZZLE_PIECE_SIZE;
      const pieceX = fraction * pieceMaxTravel;
      if (el.puzzlePiece) el.puzzlePiece.style.transform = `translateX(${pieceX}px)`;

      if (el.sliderLabel) el.sliderLabel.style.opacity = fraction > 0.08 ? "0" : "1";
      return pieceX;
    }

    function checkSnap(fraction) {
      const pieceMaxTravel = frameWidth - CONFIG.PUZZLE_PIECE_SIZE;
      const pieceX = fraction * pieceMaxTravel;
      const notchX = frameWidth * session.puzzleTargetRatio - CONFIG.PUZZLE_PIECE_SIZE / 2;

      if (Math.abs(pieceX - notchX) <= CONFIG.PUZZLE_TOLERANCE_PX) {
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
      if (el.sliderHint) {
        el.sliderHint.textContent = "✓ Puzzle aligned successfully";
        el.sliderHint.className = "hint-msg ok";
      }
      if (el.puzzlePiece) {
        el.puzzlePiece.style.boxShadow = "0 0 0 2px var(--rc-success), 0 6px 16px -4px rgba(0,0,0,0.5)";
      }
      el.sliderHandle.setAttribute("aria-disabled", "true");
      setTimeout(() => goTo("grid"), 600);
    }

    function onPointerMove(clientX) {
      const trackRect = el.sliderTrack.getBoundingClientRect();
      const fraction = (clientX - trackRect.left - handleWidth / 2) / maxHandleTravel;
      setFraction(fraction);
      return { fraction: clamp(fraction, 0, 1) };
    }

    function onDragEnd(fraction) {
      dragging = false;
      el.sliderHandle.classList.remove("dragging");
      if (state.sliderSolved) return;
      const snapped = checkSnap(fraction);
      if (!snapped) {
        setFraction(0);
        if (el.sliderHint) {
          el.sliderHint.textContent = "Not quite aligned — try again";
          el.sliderHint.className = "hint-msg error";
        }
      }
    }

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

    el.sliderHandle.addEventListener("keydown", (e) => {
      if (state.sliderSolved) return;
      measure();
      const current = Number(el.sliderHandle.getAttribute("aria-valuenow")) / 100;
      let next = current;
      if (e.key === "ArrowRight") next = current + 0.05;
      else if (e.key === "ArrowLeft") next = current - 0.05;
      else return;
      e.preventDefault();
      setFraction(next);
      checkSnap(clamp(next, 0, 1));
    });

    window.addEventListener("resize", measure);

    const observer = new MutationObserver(() => {
      const sec = document.getElementById("step-slider");
      if (sec && !sec.hidden) {
        measure();
        observer.disconnect();
      }
    });
    const sliderSec = document.getElementById("step-slider");
    if (sliderSec) {
      observer.observe(sliderSec, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  /* =======================================================================
     STEP 4 — 3x3 anomaly grid
     ======================================================================= */
  function initStep4() {
    session.tiles.forEach((tile, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tile";
      btn.dataset.index = String(i);
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", tile.label);
      btn.innerHTML = `
        <span class="tile-art ${tile.pattern}">
          <svg class="tile-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[tile.icon] || ""}</svg>
          <span class="tile-caption">${tile.label}</span>
        </span>
        <span class="tile-check">✓</span>
      `;
      btn.addEventListener("click", () => toggleTile(i, btn));
      el.grid3.appendChild(btn);
    });

    if (el.btnConfirmGrid) el.btnConfirmGrid.disabled = true;
    if (el.gridHint) {
      el.gridHint.textContent = "";
      el.gridHint.className = "hint-msg";
    }
  }

  function initStep3() {
    renderGridTiles();

    if (el.btnConfirmGrid) {
      el.btnConfirmGrid.addEventListener("click", confirmGrid);
    }

    if (el.btnReloadGrid) {
      el.btnReloadGrid.addEventListener("click", () => {
        session.tiles = shuffleArray(TILE_DATA);
        renderGridTiles();
      });
    }
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

    if (el.btnConfirmGrid) {
      el.btnConfirmGrid.disabled = state.gridSelected.size === 0;
    }
    if (el.gridHint) {
      el.gridHint.textContent = "";
      el.gridHint.className = "hint-msg";
    }
  }

  function confirmGrid() {
    const correctCount = session.tiles.filter((t, i) => t.anomaly && state.gridSelected.has(i)).length;
    const wrongCount = [...state.gridSelected].filter((i) => !session.tiles[i].anomaly).length;

    // Passing condition: at least 3 correct threats picked and zero false positives
    if (correctCount >= CONFIG.GRID_REQUIRED_CORRECT && wrongCount === 0) {
      el.gridHint.textContent = "Selection confirmed";
      el.gridHint.className = "hint-msg ok";
      el.btnConfirmGrid.disabled = true;
      setTimeout(() => goTo("robot"), 450);
    } else {
      if (el.gridHint) {
        el.gridHint.textContent = "Please select all phishing red flags and retry.";
        el.gridHint.className = "hint-msg error";
      }
    }
  }

  /* =======================================================================
     STEP 5 — authentic Google reCAPTCHA v2 widget
     ======================================================================= */
  function initStep5() {
    function triggerRobotVerification() {
      if (state.robotSolved || state.robotVerifying) return;
      state.robotVerifying = true;

      el.robotWidget.classList.add("verifying");
      el.robotWidget.setAttribute("aria-busy", "true");
      el.robotHint.textContent = "";
      el.robotHint.className = "hint-msg";

      setTimeout(() => {
        state.robotVerifying = false;
        state.robotSolved = true;
        el.robotWidget.classList.remove("verifying");
        el.robotWidget.classList.add("verified");
        el.robotWidget.setAttribute("aria-busy", "false");
        el.robotWidget.setAttribute("aria-checked", "true");
        el.robotHint.textContent = "Verification complete";
        el.robotHint.className = "hint-msg ok";
        el.btnConfirmRobot.disabled = false;

        setTimeout(() => goTo("loading"), 650);
      }, 1300);
    }

    el.robotWidget.addEventListener("click", triggerRobotVerification);

    el.robotWidget.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        triggerRobotVerification();
      }
    });

    el.btnConfirmRobot.addEventListener("click", () => {
      if (state.robotSolved) {
        goTo("loading");
      }
    });
  }

  /* =======================================================================
     STEP 6 — fake progress loader
     ======================================================================= */
  const RING_CIRCUMFERENCE = 2 * Math.PI * 44;

  function setRingProgress(pct) {
    if (!el.ringFg || !el.ringPct) return;
    const offset = RING_CIRCUMFERENCE * (1 - pct / 100);
    el.ringFg.style.strokeDashoffset = String(offset);
    el.ringPct.textContent = `${Math.round(pct)}%`;
  }

  function appendLogLine(text, isOk) {
    if (!el.logConsole) return;
    const line = document.createElement("div");
    line.className = "log-line";
    line.innerHTML = isOk ? `<span class="ok">✓</span> ${text}` : text;
    el.logConsole.appendChild(line);
    while (el.logConsole.children.length > 5) {
      el.logConsole.removeChild(el.logConsole.firstChild);
    }
  }

  function runLoader() {
    el.logConsole.innerHTML = "";
    setRingProgress(0);
    if (el.loaderStatus) el.loaderStatus.textContent = "Initializing…";

    let pct = 0;
    let logIndex = 0;
    const target = CONFIG.LOADER_TARGET_PCT;

    const tick = setInterval(() => {
      const remaining = target - pct;
      const step = Math.max(0.4, remaining * 0.045);
      pct = Math.min(target, pct + step);
      setRingProgress(pct);

      if (pct >= target) {
        clearInterval(tick);
        if (el.loaderStatus) el.loaderStatus.textContent = "Quorum reached";
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
      if (el.loaderStatus) {
        if (logIndex <= 3) el.loaderStatus.textContent = LOG_LINES[logIndex - 1];
        else el.loaderStatus.textContent = "Synchronizing key fragments…";
      }
    }, CONFIG.LOADER_LOG_INTERVAL_MS);
  }

  /* =======================================================================
     STEP 7 — success
     ======================================================================= */
  function finishSuccess() {
    const elapsedMs = state.startTime ? performance.now() - state.startTime : 0;
    el.verifyTime.textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
    el.tokenId.textContent = randHex(10);
    clearProgress();
  }

  /* ---------------------------------------------------------------------
     BOOT
     --------------------------------------------------------------------- */
  function boot() {
    session.puzzleTargetRatio = randRange(CONFIG.PUZZLE_TARGET_MIN, CONFIG.PUZZLE_TARGET_MAX);
    session.tiles = shuffleArray(TILE_DATA);

    queryElements();
    initStep1();
    initStep2();
    initStep3();
    initStep4();
    initStep5();

    const resumed = loadProgress();
    if (resumed && resumed !== "loading" && resumed !== "success" && resumed !== "intro") {
      state.step = resumed;
    }
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();