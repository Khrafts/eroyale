// Four beach billboards with chasing bulbs. Two show the open player-created rounds with the largest pots (not paid
// ads), one is a static fictional sponsor, one is the open slot (bidding is coming, nothing to submit).
import * as THREE from "three";
import { canvasFont } from "@/lib/theme";
import { C, Box, Cyl, Sph, rr, wrapText } from "../materials";
import { SAND_Y, f, type Ctx } from "../common";
import type { IslandSnap } from "@/lib/island/store";
import { ADS, SPONSOR, promoFoot, promoHead, promoted, type AdSlot } from "@/lib/island/places";

export { ADS };

export function buildBillboards(ctx: Ctx, snap0: IslandSnap) {
  const { P, cTex, m4 } = ctx.kit;
  let snap = snap0;
  function drawAd(ad: AdSlot) {
    return (cx: CanvasRenderingContext2D, w: number, h: number) => {
      const u = ad.kind === "promo" ? promoted(snap)[ad.rank!] : undefined;
      cx.fillStyle = ad.kind === "promo" && !u ? "#FFF3E4" : ad.bg;
      cx.fillRect(0, 0, w, h);
      cx.textBaseline = "alphabetic";
      cx.textAlign = "left";
      if (ad.kind === "promo" && u) {
        cx.fillStyle = "rgba(255,255,255,.14)";
        cx.beginPath();
        cx.arc(w - 90, 70, 250, 0, Math.PI * 2);
        cx.fill();
        cx.beginPath();
        cx.arc(w - 220, h + 40, 140, 0, Math.PI * 2);
        cx.fill();
        const eyebrow = `PREDICTION · ROUND #${u.lobbyId}`;
        cx.font = canvasFont("mono", 500, 26);
        const ew = cx.measureText(eyebrow).width;
        cx.fillStyle = C.ink;
        rr(cx, 44, 44, ew + 36, 50, 25);
        cx.fill();
        cx.fillStyle = C.white;
        cx.fillText(eyebrow, 62, 78);
        cx.font = canvasFont("display", 800, 68);
        cx.fillStyle = C.ink;
        wrapText(cx, promoHead(u), 52, 196, w - 110, 82);
        cx.fillStyle = C.white;
        wrapText(cx, promoHead(u), 48, 190, w - 110, 82);
        cx.font = canvasFont("body", 600, 30);
        cx.fillText(promoFoot(u), 50, h - 52);
        cx.font = canvasFont("mono", 500, 20);
        cx.fillStyle = "rgba(255,255,255,.85)";
        cx.textAlign = "right";
        cx.fillText("PLAYER ROUND", w - 40, 78);
      } else if (ad.kind === "sponsor") {
        cx.lineWidth = 6;
        for (let k = 0; k < 7; k++) {
          cx.strokeStyle = [C.wave, C.sky, C.violet][k % 3];
          cx.globalAlpha = 0.45;
          cx.beginPath();
          for (let x = 0; x <= w; x += 12) {
            const y = 320 + k * 28 + Math.sin(x / 70 + k) * 16;
            if (x) cx.lineTo(x, y);
            else cx.moveTo(x, y);
          }
          cx.stroke();
        }
        cx.globalAlpha = 1;
        cx.fillStyle = C.wave;
        cx.font = canvasFont("display", 800, 124);
        cx.fillText(SPONSOR.brand, 48, 190);
        cx.fillStyle = C.paper;
        cx.font = canvasFont("body", 500, 38);
        cx.fillText(SPONSOR.tag, 52, 260);
        cx.font = canvasFont("mono", 500, 20);
        cx.fillStyle = "rgba(255,251,245,.65)";
        cx.textAlign = "right";
        cx.fillText("SPONSORED · FICTIONAL BRAND", w - 40, 60);
      } else {
        // the open slot, or a promo board with no player round to show
        const empty = ad.kind === "promo";
        cx.strokeStyle = C.ink;
        cx.lineWidth = 10;
        cx.setLineDash([30, 18]);
        cx.strokeRect(30, 30, w - 60, h - 60);
        cx.setLineDash([]);
        cx.fillStyle = empty ? ad.bg : C.coral;
        cx.font = canvasFont("display", 800, 80);
        cx.fillText(empty ? "NO ROUNDS" : "YOUR ROUND", 64, 176);
        cx.fillStyle = C.ink;
        cx.fillText(empty ? "YET" : "HERE", 64, 264);
        cx.font = canvasFont("body", 500, 32);
        cx.fillStyle = C.ink2;
        cx.fillText(empty ? "Player rounds with the biggest pots show here" : "Promote a round you created · 24 h slot", 66, 344);
        cx.fillStyle = C.violet;
        cx.font = canvasFont("mono", 500, 30);
        cx.fillText(empty ? "Create one at the fountain" : "Bidding opens later", 66, 414);
      }
    };
  }
  const groups: Record<string, THREE.Group> = {};
  const redraws: (() => void)[] = [];
  const bulbItems: { v: THREE.Vector3; k: number }[] = [];
  ADS.forEach((ad) => {
    const g = new THREE.Group();
    [-4.2, 4.2].forEach((x) => P(g, Cyl(0.25, 0.32, 7, 10), C.ink, [x, 3.5, 0], [0, 0, 0], { ol: false }));
    P(g, Box(13, 6.8, 0.5), C.ink, [0, 10.4, 0], [0, 0, 0], { ol: 0.06 });
    const t = cTex(1024, 512, drawAd(ad));
    if (ad.kind === "promo") redraws.push(t.redraw);
    const face = new THREE.MeshBasicMaterial({ map: t.tex });
    P(g, new THREE.PlaneGeometry(12, 6), face, [0, 10.4, 0.27], [0, 0, 0], { ol: false, shadow: false });
    P(g, new THREE.PlaneGeometry(12, 6), face, [0, 10.4, -0.27], [0, Math.PI, 0], { ol: false, shadow: false });
    const a = (ad.deg * Math.PI) / 180;
    const r = 61.5 * f(a);
    g.position.set(r * Math.cos(a), SAND_Y, r * Math.sin(a));
    g.lookAt(g.position.x * 2, SAND_Y, g.position.z * 2);
    ctx.scene.add(g);
    ctx.roots.push(g);
    groups[ad.id] = g;
    ctx.addOb(g.position.x, g.position.z, 7);
    g.updateMatrixWorld(true);
    const per: [number, number][] = [];
    for (let i = 0; i < 13; i++) per.push([-6.5 + (i * 13) / 12, 13.8], [-6.5 + (i * 13) / 12, 7]);
    for (let i = 1; i < 6; i++) per.push([-6.5, 7 + (i * 6.8) / 6], [6.5, 7 + (i * 6.8) / 6]);
    per.forEach(([x, y], i) =>
      [0.3, -0.3].forEach((z) => {
        const v = new THREE.Vector3(x, y, z).applyMatrix4(g.matrixWorld);
        bulbItems.push({ v, k: i });
      }),
    );
  });
  const white = new THREE.Color(C.white);
  const tmpC = new THREE.Color();
  const bulbs = new THREE.InstancedMesh(Sph(0.2, 8, 6), new THREE.MeshBasicMaterial(), bulbItems.length);
  bulbItems.forEach((b, i) => {
    bulbs.setMatrixAt(i, m4(b.v.x, b.v.y, b.v.z));
    bulbs.setColorAt(i, white);
  });
  bulbs.frustumCulled = false;
  ctx.scene.add(bulbs);

  let key = "";
  const keyOf = (s: IslandSnap) =>
    promoted(s)
      .slice(0, 2)
      .map((u) => `${u.lobbyId}:${u.players}:${u.potUnits}`)
      .join("|");
  ctx.onFrame.push((_dt, t, s) => {
    snap = s;
    const k = keyOf(s);
    if (k !== key) {
      key = k;
      redraws.forEach((r) => r());
    }
    const step = Math.floor(t * 5);
    bulbItems.forEach((b, i) =>
      bulbs.setColorAt(i, tmpC.set((b.k + step) % 3 === 0 ? C.white : C.sun).multiplyScalar((b.k + step) % 3 === 0 ? 1 : 0.75)),
    );
    bulbs.instanceColor!.needsUpdate = true;
  });
  return { groups };
}
