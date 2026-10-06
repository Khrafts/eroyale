"use client";
// The avatar studio: a turntable preview (the world's own small renderer), every option from the prototype, the
// victory dance, Shuffle, Preview a win and Save. Your look is saved under your burner address and your name is the
// callsign /play uses.
import { useEffect, useRef, useState } from "react";
import { AV, DANCES, danceName, saveAvatar, shuffled, type AvatarCfg, type ChipKey, type SwatchKey } from "@/lib/island/avatar";
import { emit, getSnapshot, setSnap } from "@/lib/island/store";
import type { IslandApi } from "./Island";

export function AvatarStudio({ api, me }: { api: IslandApi; me: string | null }) {
  const [d, setD] = useState<AvatarCfg>(() => ({ ...getSnapshot().avatar }));
  const stage = useRef<HTMLDivElement>(null);
  const w = api.world;
  useEffect(() => {
    if (w && stage.current) w.mountPreview(stage.current, d);
    // mount once per world; changes go through previewSet
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w]);
  useEffect(() => {
    w?.previewSet(d);
  }, [w, d]);
  const set = <K extends keyof AvatarCfg>(k: K, v: AvatarCfg[K]) => setD((x) => ({ ...x, [k]: v }));
  const save = () => {
    const c = { ...d, name: d.name.trim().slice(0, 24) || "you" };
    saveAvatar(me, c);
    setSnap({ avatar: c });
  };
  const sw = (k: SwatchKey, label: string) => (
    <div className="opt">
      <span>{label}</span>
      <div className="sw" role="group" aria-label={label}>
        {AV[k].map((v) => (
          <button key={v} style={{ ["--s" as string]: v }} aria-pressed={d[k] === v} aria-label={v} onClick={() => set(k, v)} />
        ))}
      </div>
    </div>
  );
  const chips = (k: ChipKey, label: string) => (
    <div className="opt">
      <span>{label}</span>
      <div className="chips" role="group" aria-label={label}>
        {AV[k].map(([v, l]) => (
          <button key={v} aria-pressed={d[k] === v} onClick={() => set(k, v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <>
      <div className="stage" ref={stage}>
        {!w && (
          <p className="fine" style={{ margin: "auto" }}>
            3D preview needs WebGL.
          </p>
        )}
        <span className="stage-hint">
          Drag to turn · now playing <b>{danceName(d.dance)}</b>
        </span>
      </div>
      <label className="field">
        Callsign
        <input maxLength={24} value={d.name} autoComplete="off" onChange={(e) => set("name", e.target.value.slice(0, 24))} onBlur={() => set("name", d.name.trim() || "you")} />
      </label>
      {sw("shirt", "Shirt")}
      {sw("pants", "Pants")}
      {sw("skin", "Skin")}
      {chips("hat", "Headwear")}
      {sw("hatColor", "Accent colour")}
      {chips("face", "Face")}
      {chips("extra", "Extra")}
      <h3>Victory dance</h3>
      <div className="dances" role="group" aria-label="Victory dance">
        {DANCES.map(([v, n, desc]) => (
          <button key={v} aria-pressed={d.dance === v} onClick={() => set("dance", v)}>
            <b>{n}</b>
            <span>{desc}</span>
          </button>
        ))}
      </div>
      <div className="pair">
        <button className="ghost" onClick={() => setD((x) => shuffled(x.name))}>
          Shuffle
        </button>
        <button
          className="ghost"
          onClick={() => {
            save();
            if (!w) {
              api.toast("The victory stage needs the 3D view.");
              return;
            }
            api.close();
            api.setList(false);
            emit({ kind: "victory", amountUnits: null, game: "" });
          }}
        >
          Preview a win
        </button>
      </div>
      <button
        className="cta"
        onClick={() => {
          save();
          api.toast(`Saved. ${d.name.trim() || "you"} is waiting by the fountain.`);
        }}
      >
        Save avatar
      </button>
      <p className="fine">Your avatar stands in the plaza. When you win, it takes the top step in Leaderboard Park and does your dance. It lives in this browser only.</p>
    </>
  );
}
