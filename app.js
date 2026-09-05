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
    // Step 2 slider/jigsaw — notch position is randomized per page load between
    // these two ratios so the exact drag distance differs from person to person.
    PUZZLE_TARGET_MIN: 0.30,
    PUZZLE_TARGET_MAX: 0.82,
    PUZZLE_TOLERANCE_PX: 14,     // how close the piece must land to the notch to "snap"
    PUZZLE_PIECE_SIZE: 44,       // must match .puzzle-piece / .puzzle-notch width in CSS

    // Step 3 grid puzzle — minimum correct bicycle tiles the user must pick
    GRID_REQUIRED_CORRECT: 3,

    // Step 4 fake loader
    LOADER_TARGET_PCT: 92,       // loader climbs to this, never quite hits 100 on its own
    LOADER_FINAL_JUMP_MS: 550,   // after target reached, short pause then jump to 100%
    LOADER_TICK_MS: 90,          // how often the progress ring updates
    LOADER_LOG_INTERVAL_MS: 620, // how often a new fake log line appears

    // localStorage key for resuming progress if the page reloads mid-flow
    STORAGE_KEY: "edgegate_verify_progress_v1",
  };

  // Dynamic verification stages for Step 4
  const VERIFICATION_PHASES = [
    { threshold: 0,  label: "Validating session integrity…", sub: "Session fingerprint confirmed" },
    { threshold: 25, label: "Analyzing security handshake…", sub: "Establishing encrypted channel" },
    { threshold: 52, label: "Verifying cryptographic token…", sub: "Cross-referencing attestation key" },
    { threshold: 78, label: "Confirming human attestation…", sub: "Generating access clearance" },
    { threshold: 98, label: "Authorization confirmed ✓", sub: "Access granted" },
  ];

  // Real photo grid items for Step 3 (Select all images with bicycles)
  const TILE_DATA = [
    { label: "Road Bicycle",       isTarget: true,  src: "assets/tile-bike-1.webp" },
    { label: "Sedan Car",          isTarget: false, src: "assets/tile-car.webp" },
    { label: "Vintage Bicycle",    isTarget: true,  src: "assets/tile-bike-2.webp" },
    { label: "Traffic",            isTarget: false, src: "assets/tile-traffic.webp" },
    { label: "City Bicycle",       isTarget: true,  src: "assets/tile-bike-3.webp" },
    { label: "City Bus",           isTarget: false, src: "assets/tile-bus.webp" },
    { label: "Fire Hydrant",       isTarget: false, src: "assets/tile-hydrant.webp" },
    { label: "Motorcycle",         isTarget: false, src: "assets/tile-motor.webp" },
    { label: "Mountain Bicycle",   isTarget: true,  src: "assets/tile-bike-4.webp" },
  ];

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

  const session = {
    puzzleTargetRatio: 0.5,
    tiles: [],
  };

  /* ---------------------------------------------------------------------
     DOM refs
     --------------------------------------------------------------------- */
  let el = {};

  function queryElements() {
    el = {
      statusLine: document.getElementById("statusLine"),
      dots: document.querySelectorAll(".dot"),

      // step 1
      humanCheck: document.getElementById("humanCheck"),
      rcCheckboxVisual: document.getElementById("rcCheckboxVisual"),

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
      btnReloadGrid: document.getElementById("btnReloadGrid"),
      gridHint: document.getElementById("gridHint"),

      // step 4
      ringFg: document.getElementById("ringFg"),
      ringPct: document.getElementById("ringPct"),
      linearBar: document.getElementById("linearBar"),
      loaderStatus: document.getElementById("loaderStatus"),
      phaseText: document.getElementById("phaseText"),
      pulseDot: document.querySelector(".pulse-dot"),

      // step 5
      verifyTime: document.getElementById("verifyTime"),
      tokenId: document.getElementById("tokenId"),
    };
  }

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
    } catch (e) {}
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (STEPS.includes(parsed.step)) return parsed.step;
    } catch (e) {}
    return null;
  }

  function clearProgress() {
    try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch (e) {}
  }

  /* ---------------------------------------------------------------------
     STATE MACHINE — goTo()
     --------------------------------------------------------------------- */
  function goTo(step) {
    state.step = step;
    saveProgress();
    render();

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
      slider: "Align puzzle fragment",
      grid: "Object verification",
      loading: "Confirming check-in…",
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

        setTimeout(() => {
          if (el.rcCheckboxVisual) el.rcCheckboxVisual.classList.remove("loading");
          goTo("slider");
        }, 550);
      }
    });
  }

  /* =======================================================================
     STEP 2 — Slider / Jigsaw Puzzle
     ======================================================================= */
  function initStep2() {
    if (!el.sliderTrack || !el.sliderHandle || !el.puzzleFrame) return;

    let dragging = false;
    let trackWidth = 0;
    let handleWidth = 0;
    let frameWidth = 0;
    let frameHeight = 0;
    let maxHandleTravel = 0;

    function measure() {
      if (!el.sliderTrack || !el.puzzleFrame) return;
      trackWidth = el.sliderTrack.clientWidth;
      handleWidth = el.sliderHandle.offsetWidth;
      maxHandleTravel = Math.max(1, trackWidth - handleWidth - 4);
      frameWidth = el.puzzleFrame.clientWidth;
      frameHeight = el.puzzleFrame.clientHeight;

      const notchLeft = frameWidth * session.puzzleTargetRatio - CONFIG.PUZZLE_PIECE_SIZE / 2;
      const notchTop = frameHeight * 0.35;
      if (el.puzzleNotch) {
        el.puzzleNotch.style.left = `${Math.max(0, notchLeft)}px`;
        el.puzzleNotch.style.top = `${notchTop}px`;
      }
      if (el.puzzlePiece) {
        el.puzzlePiece.style.top = `${notchTop}px`;
        el.puzzlePiece.style.backgroundSize = `${frameWidth}px ${frameHeight}px`;
        el.puzzlePiece.style.backgroundPosition = `-${Math.max(0, notchLeft)}px -${notchTop}px`;
      }
    }

    function setFraction(fraction) {
      fraction = clamp(fraction, 0, 1);
      const handleX = fraction * maxHandleTravel;
      el.sliderHandle.style.transform = `translateX(${handleX}px)`;
      if (el.sliderFill) el.sliderFill.style.width = `${(handleX + handleWidth / 2) / trackWidth * 100}%`;
      el.sliderHandle.setAttribute("aria-valuenow", Math.round(fraction * 100));

      const pieceMaxTravel = Math.max(1, frameWidth - CONFIG.PUZZLE_PIECE_SIZE);
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

    // Keyboard support
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
      const sliderSec = document.getElementById("step-slider");
      if (sliderSec && !sliderSec.hidden) {
        setTimeout(measure, 50);
      }
    });
    const sliderSec = document.getElementById("step-slider");
    if (sliderSec) observer.observe(sliderSec, { attributes: true, attributeFilter: ["hidden"] });
  }

  /* =======================================================================
     STEP 3 — 3x3 Real Photo Grid Challenge (Bicycles)
     ======================================================================= */
  function renderGridTiles() {
    if (!el.grid3) return;
    el.grid3.innerHTML = "";
    state.gridSelected.clear();

    session.tiles.forEach((tile, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tile";
      btn.dataset.index = String(i);
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", tile.label);
      btn.innerHTML = `
        <img class="tile-img" src="${tile.src}" alt="${tile.label}" loading="eager" draggable="false">
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
    const correctCount = session.tiles.filter((t, i) => t.isTarget && state.gridSelected.has(i)).length;
    const wrongCount = [...state.gridSelected].filter((i) => !session.tiles[i].isTarget).length;

    // Passing condition: at least 3 bicycles selected and zero wrong selections
    if (correctCount >= CONFIG.GRID_REQUIRED_CORRECT && wrongCount === 0) {
      if (el.gridHint) {
        el.gridHint.textContent = "Verification confirmed ✓";
        el.gridHint.className = "hint-msg ok";
      }
      if (el.btnConfirmGrid) el.btnConfirmGrid.disabled = true;
      setTimeout(() => goTo("loading"), 500);
    } else {
      if (el.gridHint) {
        el.gridHint.textContent = "Please select all squares with bicycles and retry.";
        el.gridHint.className = "hint-msg error";
      }
    }
  }

  /* =======================================================================
     STEP 4 — Verification Progress Loader
     ======================================================================= */
  const RING_CIRCUMFERENCE = 2 * Math.PI * 44;

  function setProgress(pct) {
    if (el.ringFg && el.ringPct) {
      const offset = RING_CIRCUMFERENCE * (1 - pct / 100);
      el.ringFg.style.strokeDashoffset = String(offset);
      el.ringPct.textContent = `${Math.round(pct)}%`;
    }
    if (el.linearBar) {
      el.linearBar.style.width = `${Math.round(pct)}%`;
    }
  }

  function updatePhaseText(pct) {
    let currentPhase = VERIFICATION_PHASES[0];
    for (let i = VERIFICATION_PHASES.length - 1; i >= 0; i--) {
      if (pct >= VERIFICATION_PHASES[i].threshold) {
        currentPhase = VERIFICATION_PHASES[i];
        break;
      }
    }
    if (el.phaseText && el.phaseText.textContent !== currentPhase.label) {
      el.phaseText.textContent = currentPhase.label;
    }
    if (el.loaderStatus && el.loaderStatus.textContent !== currentPhase.sub) {
      el.loaderStatus.textContent = currentPhase.sub;
    }
  }

  function runLoader() {
    setProgress(0);
    updatePhaseText(0);
    if (el.pulseDot) {
      el.pulseDot.style.background = "var(--rc-blue)";
      el.pulseDot.style.boxShadow = "";
    }

    let pct = 0;
    const target = CONFIG.LOADER_TARGET_PCT;

    const tick = setInterval(() => {
      const remaining = target - pct;
      const step = Math.max(0.4, remaining * 0.045);
      pct = Math.min(target, pct + step);
      setProgress(pct);
      updatePhaseText(pct);

      if (pct >= target) {
        clearInterval(tick);
        setTimeout(() => {
          setProgress(100);
          updatePhaseText(100);
          if (el.pulseDot) {
            el.pulseDot.style.background = "var(--rc-success)";
            el.pulseDot.style.boxShadow = "0 0 0 5px rgba(30, 142, 62, 0.25)";
          }
          setTimeout(() => goTo("success"), CONFIG.LOADER_FINAL_JUMP_MS);
        }, 350);
      }
    }, CONFIG.LOADER_TICK_MS);
  }

  /* =======================================================================
     STEP 5 — Success Screen
     ======================================================================= */
  function finishSuccess() {
    const elapsedMs = state.startTime ? performance.now() - state.startTime : 0;
    if (el.verifyTime) el.verifyTime.textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
    if (el.tokenId) el.tokenId.textContent = randHex(10);
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

    const hash = window.location.hash.replace("#", "");
    if (STEPS.includes(hash)) {
      goTo(hash);
    } else {
      const resumed = loadProgress();
      if (resumed && resumed !== "loading" && resumed !== "success" && resumed !== "intro") {
        state.step = resumed;
      }
      render();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();