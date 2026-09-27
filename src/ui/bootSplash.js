/**
 * SATWQ cinematic boot splash.
 *
 * A full-screen "mission control" cold-boot sequence that plays while the
 * globe initializes underneath: scanline sweep, type-in of the SATWQ banner,
 * a short boot log, then a fade into the live scene. Pure DOM + CSS, no
 * dependencies, no network. Respects `prefers-reduced-motion` and the
 * `?nosplash=1` query flag (both skip straight to the app).
 */

const BOOT_LINES = [
  ['SATWQ REALITY OS // GLOBAL COMMAND', 'banner'],
  ['> uplink established ............ OK', 'ok'],
  ['> sensor mesh sync .............. OK', 'ok'],
  ['> orbital catalog ............... OK', 'ok'],
  ['> signal fusion core ............ ONLINE', 'amber'],
];

const MIN_DISPLAY_MS = 2600;

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function skipSplash() {
  try {
    return new URLSearchParams(window.location.search).get('nosplash') === '1';
  } catch {
    return false;
  }
}

/** Show the boot splash immediately. Returns { ready(), fail(error) }. */
export function showBootSplash() {
  if (skipSplash() || prefersReducedMotion()) {
    return { ready: () => {}, fail: () => {} };
  }

  const root = document.createElement('div');
  root.id = 'satwq-boot';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-label', 'SATWQ Reality OS booting');
  root.innerHTML = `
    <div class="satwq-boot-scan" aria-hidden="true"></div>
    <div class="satwq-boot-inner">
      <div class="satwq-boot-kicker">SATWQ · REALITY OS</div>
      <div class="satwq-boot-lines"></div>
      <div class="satwq-boot-credit">built on bilawalsidhu/gods-eye-view · MIT</div>
    </div>`;
  document.body.appendChild(root);

  const linesEl = root.querySelector('.satwq-boot-lines');
  const shownAt = Date.now();
  let cancelled = false;

  // Type the banner, then stream the boot log lines.
  (async () => {
    for (const [text, kind] of BOOT_LINES) {
      if (cancelled) return;
      const line = document.createElement('div');
      line.className = `satwq-boot-line satwq-boot-line--${kind}`;
      linesEl.appendChild(line);
      if (kind === 'banner') {
        await typeText(line, text, 34);
      } else {
        line.textContent = text;
        await sleep(260);
      }
    }
  })().catch(() => {});

  function dismiss() {
    if (cancelled) return;
    cancelled = true;
    root.classList.add('satwq-boot--done');
    window.setTimeout(() => root.remove(), 900);
  }

  return {
    /** Call once the application has started; fades out after the min display. */
    ready() {
      const wait = Math.max(0, MIN_DISPLAY_MS - (Date.now() - shownAt));
      window.setTimeout(dismiss, wait);
    },
    /** Surface a startup failure inside the splash before dismissing. */
    fail(error) {
      const line = document.createElement('div');
      line.className = 'satwq-boot-line satwq-boot-line--error';
      line.textContent = `> BOOT FAULT: ${error?.message || error}`;
      linesEl.appendChild(line);
      window.setTimeout(dismiss, 1800);
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function typeText(el, text, perCharMs) {
  for (let i = 1; i <= text.length; i++) {
    el.textContent = text.slice(0, i);
    // eslint-disable-next-line no-await-in-loop
    await sleep(perCharMs);
  }
  await sleep(320);
}
