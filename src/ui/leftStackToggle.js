/**
 * Whole-stack hide for the left panel rail.
 *
 * The rail's panels each collapse individually, but there was no way to
 * clear the whole stack for a clean globe short of CLEAN UI (which hides
 * everything). This binds the #left-stack-toggle tab shipped in
 * layer-panels.html: it flips a body class the stylesheet uses to hide
 * every stack panel at once, and persists the choice like other shell
 * preferences. Fail-soft by design — mount it in a try/catch like the
 * other post-boot packs.
 */
const STORAGE_KEY = 'gev-left-stack-hidden';

export function initLeftStackToggle({ documentRef = document } = {}) {
  const button = documentRef?.getElementById?.('left-stack-toggle');
  const stack = documentRef?.getElementById?.('left-panel-stack');
  if (!button || !stack || !documentRef?.body) return null;

  const apply = (hidden) => {
    documentRef.body.classList.toggle('left-stack-hidden', hidden);
    button.setAttribute('aria-expanded', String(!hidden));
    button.title = hidden
      ? 'Show the left panel stack'
      : 'Hide the left panel stack';
    const arrow = button.querySelector('.left-stack-toggle-arrow');
    if (arrow) arrow.textContent = hidden ? '›' : '‹';
  };

  let hidden = false;
  try {
    hidden = window.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    /* storage blocked — session-only toggle */
  }
  apply(hidden);

  const onClick = () => {
    hidden = !hidden;
    apply(hidden);
    try {
      window.localStorage?.setItem(STORAGE_KEY, hidden ? '1' : '0');
    } catch {
      /* best-effort persistence only */
    }
  };
  button.addEventListener('click', onClick);
  return {
    destroy() {
      button.removeEventListener('click', onClick);
    },
  };
}
