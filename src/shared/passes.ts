// Polling that asks about many things one at a time. A fixed interval starts a
// new pass whether or not the last one has finished, so when a pass outlasts
// the interval (a few hundred clips at a couple of seconds each) the passes
// pile up and every one of them keeps asking.

/**
 * Runs `pass` now, then again `gapMs` after each one finishes: never two at
 * once. Returns `stop`, after which no pass starts and the one under way sees
 * `stopped()` turn true, so it can give up partway.
 */
export function repeatPasses(pass: (stopped: () => boolean) => Promise<void>, gapMs: number): () => void {
  let dead = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = () => dead;
  const run = async () => {
    try {
      await pass(stopped);
    } catch {
      /* a pass that throws is retried like any other */
    }
    if (!dead) timer = setTimeout(run, gapMs);
  };
  void run();
  return () => {
    dead = true;
    clearTimeout(timer);
  };
}
