"use client";
// Open/close state for the app bar's small menus (the compact switcher, the you chip): a press outside closes, Escape
// closes and returns focus to the button without reaching the page's own Escape (back to the parent).
import { useEffect, useRef, useState } from "react";

export function usePopover<B extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<B>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
      btn.current?.focus();
    };
    addEventListener("pointerdown", down);
    addEventListener("keydown", key, true);
    return () => {
      removeEventListener("pointerdown", down);
      removeEventListener("keydown", key, true);
    };
  }, [open]);
  return { open, setOpen, box, btn };
}
