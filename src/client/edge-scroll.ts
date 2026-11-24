// Scroll the timeline while a drag is held near its edge, so a clip, a trim
// handle or the playhead can be taken past what is in view.

/** How close to the edge, in px, a drag starts scrolling. */
const EDGE = 48;
/** Fastest scroll, in px per second, reached at the edge and beyond it. Per second, not per frame, so a 120 Hz screen scrolls no faster. */
const MAX_SPEED = 700;

/**
 * Start one drag's auto-scroll on `el`, a horizontally scrolling track area
 * whose first `leftInset` px are a sticky label column. Call `move` from the
 * drag's pointermove and `stop` from its pointerup. While the pointer rests
 * near an edge, `el` scrolls and `onScroll` runs with the pointer's x, so the
 * drag can re-apply itself to the content now under the pointer.
 */
export function edgeScroll(el: HTMLElement, leftInset: number, onScroll: (clientX: number) => void) {
  let x = 0;
  let raf = 0;
  let last = 0;
  let carry = 0;

  // Negative near the left edge, positive near the right, faster the closer
  // the pointer is, and zero once there is nothing further to scroll to.
  const speed = () => {
    const box = el.getBoundingClientRect();
    const left = box.left + leftInset;
    const ramp = (d: number) => MAX_SPEED * Math.min(1, (EDGE - d) / EDGE);
    if (x < left + EDGE && el.scrollLeft > 0) return -ramp(x - left);
    if (x > box.right - EDGE && el.scrollLeft < el.scrollWidth - el.clientWidth) return ramp(box.right - x);
    return 0;
  };

  const tick = (now: number) => {
    const v = speed();
    if (!v) {
      raf = 0;
      return;
    }
    // The first frame only sets the clock; a long gap (a background tab) counts as one frame.
    const dt = last ? Math.min(now - last, 50) / 1000 : 0;
    last = now;
    const step = v * dt + carry;
    const whole = Math.trunc(step);
    carry = step - whole;
    if (whole) {
      el.scrollLeft += whole;
      onScroll(x);
    }
    raf = requestAnimationFrame(tick);
  };

  return {
    move(clientX: number) {
      x = clientX;
      if (!raf && speed()) {
        last = 0;
        carry = 0;
        raf = requestAnimationFrame(tick);
      }
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
