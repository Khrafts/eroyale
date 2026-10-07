"use client";
// Touch controls: an eight-way pad at bottom left, A and B at bottom right (both at once is a throw; the small A+B
// button does the same with one thumb). Pointer events, so several fingers work at once.
import { useRef, useState, type PointerEvent } from "react";
import { A, B, D, L, R, U, type InputSource } from "./input";
import s from "./duel.module.css";

function padBits(dx: number, dy: number, r: number): number {
  if (Math.hypot(dx, dy) < r * 0.22) return 0;
  const a = Math.atan2(-dy, dx); // up is positive
  const oct = Math.round(a / (Math.PI / 4)); // -4..4
  const map: Record<number, number> = { 0: R, 1: R | U, 2: U, 3: L | U, 4: L, [-4]: L, [-3]: L | D, [-2]: D, [-1]: R | D };
  return map[oct] ?? 0;
}

export function Controls({ input }: { input: InputSource }) {
  const pad = useRef<HTMLDivElement>(null);
  const [dir, setDir] = useState(0);
  const [held, setHeld] = useState(0);
  const movePad = (e: PointerEvent<HTMLDivElement>) => {
    const el = pad.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const b = padBits(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), r.width / 2);
    input.setTouch("pad", b);
    setDir(b);
  };
  const endPad = () => {
    input.setTouch("pad", 0);
    setDir(0);
  };
  const btn = (bit: number, label: string, cls: string, aria: string) => (
    <button
      type="button"
      className={`${s.btn} ${cls}`}
      aria-label={aria}
      aria-pressed={(held & bit) === bit}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        input.setTouch(`b${e.pointerId}`, bit);
        setHeld((h) => h | bit);
      }}
      onPointerUp={(e) => {
        input.setTouch(`b${e.pointerId}`, 0);
        setHeld((h) => h & ~bit);
      }}
      onPointerCancel={(e) => {
        input.setTouch(`b${e.pointerId}`, 0);
        setHeld((h) => h & ~bit);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
  const arrow = (bit: number) => (dir & bit ? s.on : "");
  return (
    <div className={s.controls}>
      <div
        ref={pad}
        className={s.pad}
        role="group"
        aria-label="Direction pad"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          movePad(e);
        }}
        onPointerMove={(e) => e.buttons && movePad(e)}
        onPointerUp={endPad}
        onPointerCancel={endPad}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className={`${s.arr} ${s.up} ${arrow(U)}`} />
        <span className={`${s.arr} ${s.down} ${arrow(D)}`} />
        <span className={`${s.arr} ${s.left} ${arrow(L)}`} />
        <span className={`${s.arr} ${s.right} ${arrow(R)}`} />
        <span className={s.nub} style={{ transform: `translate(${dir & R ? 14 : dir & L ? -14 : 0}px, ${dir & D ? 14 : dir & U ? -14 : 0}px)` }} />
      </div>
      <div className={s.buttons}>
        {btn(A | B, "A+B", s.throw, "Throw (A and B)")}
        {btn(A, "A", s.a, "A: jab, air attack")}
        {btn(B, "B", s.b, "B: heavy, sweep with down")}
      </div>
    </div>
  );
}
