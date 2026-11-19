import { useEffect, useState } from "react";

/** True while a chart should play its draw-in animation: once when data first arrives (and again when
 *  `resetKey` changes), then false so periodic data refreshes don't replay it. */
export function useDrawOnce(ready: boolean, resetKey: unknown = 0, ms = DRAW_MS + 400) {
  const key = String(resetKey);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setDone(key), ms);
    return () => clearTimeout(t);
  }, [ready, key, ms]);
  return done !== key;
}

export const DRAW_MS = 1800;
