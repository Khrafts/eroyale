"use client";
// The app bar's "you" chip (CLAUDE.md "Navigation" rule 3): a button that opens a small menu with your avatar head and
// callsign, copy address, and "My avatar" (the island's studio). Loaded lazily by bar.tsx; closes as popover.ts says.
import Link from "./link";
import { useState, type ReactNode } from "react";
import { usePopover } from "./popover";
import { island, me } from "@/lib/nav";
import k from "./kit.module.css";
import n from "./nav.module.css";

const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export default function YouChip({ wallet, callsign, avatar }: { wallet: string; callsign?: string | null; avatar?: ReactNode }) {
  const { open, setOpen, box, btn } = usePopover();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(wallet).then(() => setCopied(true), () => setCopied(false));
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className={n.you} ref={box}>
      <button
        ref={btn}
        type="button"
        className={`${k.chip} ${n.youBtn}`}
        aria-label={`You: ${callsign ? `${callsign}, ` : ""}${shortAddr(wallet)}`}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls="you-menu"
        title={wallet}
        onClick={() => setOpen((o) => !o)}
      >
        {avatar && <span className={n.youHead}>{avatar}</span>}
        <span className={k.wallet}>{shortAddr(wallet)}</span>
      </button>
      {open && (
        <div id="you-menu" className={n.menu} role="group" aria-label="You">
          <div className={n.youId}>
            {avatar && <span className={n.youBig}>{avatar}</span>}
            <span>
              <b>{callsign || "No callsign yet"}</b>
              <span className={k.wallet}>{shortAddr(wallet)}</span>
            </span>
          </div>
          <button type="button" className={n.item} onClick={copy}>
            {copied ? "Address copied" : "Copy address"}
          </button>
          <Link className={n.item} href={island("studio")} onClick={() => setOpen(false)}>
            My avatar
          </Link>
          <Link className={n.item} href={me()} onClick={() => setOpen(false)}>
            My activity
          </Link>
        </div>
      )}
    </div>
  );
}
