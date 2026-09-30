/**
 * Akashic Records — fail-soft mount (wave3, part C item 1).
 *
 * `initAkashicArchive({ viewer, dvr, pollMs })`:
 *   - starts the archiver sweep loop (polls keyless feeds, archives to the
 *     day-keyed store in localStorage),
 *   - mounts a floating "◈ records" toggle button + scrubbable timeline panel,
 *   - composes with the existing GIBS DVR when a dvr layer is supplied
 *     ("view in DVR" hands the selected day to dvr.setTime(day)).
 *
 * One throwing mount can never break the host app.
 */
import { createAkashicStore, createLocalStorageBackend } from './store.js';
import { runArchiveSweep } from './archiver.js';
import { createAkashicTimeline } from './timeline.js';

export const ARCHIVE_POLL_MS = 10 * 60 * 1000; // 10 minutes

export function initAkashicArchive({ viewer = null, dvr = null, pollMs = ARCHIVE_POLL_MS } = {}) {
  if (typeof document === 'undefined') return null;
  const cleanups = [];
  try {
    const storage = typeof window !== 'undefined' ? window.localStorage : null;
    const store = createAkashicStore({ backend: createLocalStorageBackend(storage) });

    let stopped = false;
    const sweepOnce = async () => {
      try {
        const summary = await runArchiveSweep(store);
        if (summary.added > 0) console.info('[akashic] archived', summary.added, 'new events');
      } catch (error) {
        console.warn('[akashic] sweep failed:', error);
      }
    };

    // First sweep shortly after mount, then on the poll interval.
    const kickoff = setTimeout(() => {
      if (!stopped) sweepOnce();
    }, 15000);
    cleanups.push(() => clearTimeout(kickoff));
    const timer = setInterval(() => {
      if (!stopped) sweepOnce();
    }, pollMs);
    cleanups.push(() => clearInterval(timer));

    // Phone-first: src/akashic/ui.js mounts the timeline bar, which is the
    // mobile timeline UI. The floating toggle + panel below would overlap
    // it, so they stay desktop-only. The archiver sweep above keeps
    // running on all viewports — only the redundant toggle is gated.
    let smallViewport = false;
    try {
      smallViewport =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(max-width: 768px)').matches;
    } catch {
      /* matchMedia unavailable — keep the desktop default */
    }

    const timeline = smallViewport
      ? null
      : createAkashicTimeline({ store, viewer, dvr });
    if (timeline) cleanups.push(() => timeline.destroy());

    if (!smallViewport) {
      const btn = document.createElement('button');
      btn.textContent = '◈ records';
      btn.setAttribute('aria-label', 'Open Akashic Records timeline');
      btn.style.cssText =
        'position:fixed;right:12px;bottom:12px;z-index:9990;padding:7px 12px;border-radius:20px;' +
        'border:1px solid rgba(120,180,255,.35);background:rgba(8,12,20,.88);color:#9fc2ff;' +
        'cursor:pointer;font-size:11px;letter-spacing:.06em;';
      btn.addEventListener('click', () => {
        if (timeline) {
          const open = timeline.element.style.display !== 'none';
          if (open) timeline.close();
          else timeline.open();
        }
      });
      document.body.appendChild(btn);
      cleanups.push(() => btn.remove());
    }

    return () => {
      stopped = true;
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    };
  } catch (error) {
    console.warn('[akashic] mount failed:', error);
    return null;
  }
}

export { createAkashicStore, runArchiveSweep, createAkashicTimeline };
