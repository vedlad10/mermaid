/**
 * Presentation mode — PHI minimisation as a product-wide setting (spec §8.6).
 *
 * ── WHY THIS IS NOT A PATIENTS-SCREEN FEATURE ────────────────────────────────────────────────────
 * §8.6 puts the toggle in the context bar and says it masks identifiers "across the entire product",
 * and that is the only version of it worth building. The scene it exists for is a laptop turned
 * around in an operatory, or a screen shared in a huddle — and in that scene the manager does not
 * get to promise they will only look at the one screen that honours the setting. A mask that covers
 * six screens out of eight is worse than none, because it is trusted.
 *
 * So the state lives on `document.body`, every screen reads it through `maskName`, and turning it on
 * redraws whatever is mounted.
 *
 * ── WHAT IT MASKS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────────────
 * Names become initials. Member IDs — which are the other identifier on these screens, and the one a
 * payer would recognise — keep only their last two characters, because a biller reading a queue over
 * someone's shoulder still needs to tell two rows apart.
 *
 * Money is never masked. It is the subject of every screen here, hiding it would make the product
 * useless in exactly the room this mode is for, and it identifies nobody on its own.
 *
 * ── WHY IT IS NOT PERSISTED ──────────────────────────────────────────────────────────────────────
 * A privacy mode that survives a reload is a privacy mode someone leaves on and then cannot read
 * their own screen through. More importantly the failure is asymmetric: forgetting to turn it ON is
 * a disclosure, forgetting to turn it OFF is an inconvenience — but a mode that persists invisibly
 * across sessions trains people to distrust what they are reading, which ends with it switched off
 * permanently. It is per-sitting, and deliberately obvious while it is on.
 */

const ATTR = "data-presenting";

/** Is presentation mode on right now? */
export const isPresenting = () => document.body.hasAttribute(ATTR);

/**
 * Turn it on or off, and tell the mounted screen to redraw.
 *
 * The redraw goes through a DOM event rather than a callback registry: screens come and go, and a
 * registry of live screens is a list something eventually forgets to remove itself from.
 */
export function setPresenting(on) {
  if (on) document.body.setAttribute(ATTR, "");
  else document.body.removeAttribute(ATTR);
  document.dispatchEvent(new CustomEvent("mermaid:presenting", { detail: { on } }));
}

/**
 * A person's name, masked to initials when presentation mode is on.
 *
 * "Sasha Mockfile" becomes "S.M." — enough to keep two rows apart and match a name you already
 * know, not enough to read one off a screen you were not meant to be reading.
 *
 * A name that is absent stays absent: masking a missing value into "—" would make "we do not know
 * who this is" indistinguishable from "we are not telling you", and those are different facts.
 */
export function maskName(name) {
  if (!name) return name;
  if (!isPresenting()) return name;
  const initials = String(name)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase())
    .join(".");
  return initials ? `${initials}.` : "—";
}

/**
 * An identifier a payer would recognise, reduced to its last two characters.
 *
 * Not blanked entirely, because the identifier is often the only thing distinguishing two rows for
 * the same family — a member ID is shared across a policy, and a queue that showed "•••" twice
 * would be a queue nobody could work from.
 */
export function maskId(id) {
  if (!id) return id;
  if (!isPresenting()) return id;
  const s = String(id);
  return s.length <= 2 ? "••" : `••••${s.slice(-2)}`;
}

/**
 * A control for the mode, for whichever surface hosts it.
 *
 * Returns a real button rather than markup, so the caller owns placement and this module owns the
 * behaviour and the wording. The wording matters: "Presenting" states the mode, and the pressed
 * state is what makes it obvious enough to turn off again.
 */
export function presentingToggle() {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pmode";
  /*
   * Two labels, and CSS picks. At 375px "Presentation mode" wrapped to two lines and shoved the
   * wordmark into the controls beside it — the header is a space-between row, and a button that
   * wraps grows taller rather than narrower, so nothing else could give.
   *
   * The full phrase stays the ACCESSIBLE name at every width. A screen reader should never get the
   * abbreviation just because the viewport is narrow: "Present" on its own is a verb, and this
   * control is not about presenting anything — it is about hiding patient names.
   */
  const long = document.createElement("span");
  long.className = "pmode__long";
  const short = document.createElement("span");
  short.className = "pmode__short";
  b.replaceChildren(long, short);
  const paint = () => {
    const on = isPresenting();
    const full = on ? "Presenting · names hidden" : "Presentation mode";
    long.textContent = full;
    short.textContent = on ? "Names hidden" : "Presentation";
    b.setAttribute("aria-label", full);
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", String(on));
    b.title = on
      ? "Patient names and member IDs are masked. Click to show them again."
      : "Mask patient names and member IDs across every screen, for a shared or patient-facing display.";
  };
  b.addEventListener("click", () => setPresenting(!isPresenting()));
  document.addEventListener("mermaid:presenting", paint);
  paint();
  return b;
}
