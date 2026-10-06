"use client";
import { useEffect, useRef, useState } from "react";

/** Number that rolls toward its target every frame (cross-fade free: it just counts). */
export function useRolling(target: number, reduced: boolean) {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    if (reduced) {
      cur.current = target;
      setV(target);
      return;
    }
    let raf = 0;
    const step = () => {
      const d = target - cur.current;
      if (Math.abs(d) < 0.005) {
        cur.current = target;
        setV(target);
        return;
      }
      cur.current += d * 0.18;
      setV(cur.current);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);
  return v;
}
