// Input bits (CLAUDE.md "Stickman Duel": 1 left, 2 right, 4 up, 8 down, 16 A, 32 B) from the keyboard (arrows, Z = A,
// X = B, listened on window so no focus is needed) and from the touch pad and buttons. One shared, mutable source:
// the fight loop reads `bits()` each tick.
export const L = 1, R = 2, U = 4, D = 8, A = 16, B = 32;

const KEYS: Record<string, number> = { ArrowLeft: L, ArrowRight: R, ArrowUp: U, ArrowDown: D, KeyZ: A, KeyX: B, z: A, x: B, Z: A, X: B };

export type InputSource = { bits: () => number; setTouch: (id: string, b: number) => void; dispose: () => void };

export function createInput(): InputSource {
  let keys = 0;
  const touch = new Map<string, number>();
  const down = (e: KeyboardEvent) => {
    const b = KEYS[e.code] ?? KEYS[e.key];
    if (!b) return;
    keys |= b;
    e.preventDefault();
  };
  const up = (e: KeyboardEvent) => {
    const b = KEYS[e.code] ?? KEYS[e.key];
    if (!b) return;
    keys &= ~b;
    e.preventDefault();
  };
  const blur = () => {
    keys = 0;
    touch.clear();
  };
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  window.addEventListener("blur", blur);
  return {
    bits: () => {
      let b = keys;
      touch.forEach((v) => (b |= v));
      // left and right together cancel (a thumb sliding across the pad)
      if ((b & (L | R)) === (L | R)) b &= ~(L | R);
      return b;
    },
    setTouch: (id, b) => (b ? touch.set(id, b) : touch.delete(id)),
    dispose: () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    },
  };
}
