// Leaderboard Park: hedge ring, arch of bulbs, ten trophy columns (height follows winnings), and a podium where
// the top three dance. Your own avatar stands in the plaza and takes the top step when you win.
import * as THREE from "three";
import { C, Box, Cyl, Sph } from "../materials";
import { G, LAYOUT, place, polar, type Ctx } from "../common";
import { makeAvatar, type Rig } from "../avatar/rig";
import { pose } from "../avatar/dances";
import { cfgFor, type AvatarCfg } from "@/lib/island/avatar";
import type { IslandSnap } from "@/lib/island/store";

export function buildPark(ctx: Ctx, snap0: IslandSnap) {
  const { P, basic, kit } = { ...ctx.kit, kit: ctx.kit };
  const park = new THREE.Group();
  P(park, Cyl(13, 13, 0.3, 64), "#7EE08A", [0, 0.15, 0], [0, 0, 0], { ol: 0.08 });
  P(park, new THREE.TorusGeometry(12.7, 1.05, 8, 72, Math.PI * 2 - 0.7), "#2FA866", [0, 0.8, 0], [Math.PI / 2, 0, Math.PI / 2 + 0.35], { ol: 0.08 });
  const arch = new THREE.Group();
  arch.position.set(0, 0.3, 12.7);
  park.add(arch);
  P(arch, new THREE.TorusGeometry(4.2, 0.45, 10, 40, Math.PI), C.sun, [0, 0, 0], [0, 0, 0], { ol: 0.06 });
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI;
    P(arch, Sph(0.22, 8, 6), basic(i % 2 ? C.white : "#FFE58A"), [4.2 * Math.cos(a), 4.2 * Math.sin(a), 0.45], [0, 0, 0], { ol: false, shadow: false });
  }
  const trophies: { col: THREE.Mesh; cup: THREE.Group }[] = [];
  for (let i = 0; i < 10; i++) {
    const phi = Math.PI + ((i + 0.5) / 10) * Math.PI;
    const g = new THREE.Group();
    g.position.set(9 * Math.cos(phi), 0.3, 9 * Math.sin(phi));
    park.add(g);
    const col = P(g, Cyl(0.85, 1, 1, 10), "#FFFAF2", [0, 0.5, 0], [0, 0, 0], { ol: 0.05 });
    const cup = new THREE.Group();
    g.add(cup);
    const cc = i === 0 ? C.sun : i === 1 ? C.silver : i === 2 ? C.bronze : [C.sky, C.mint, C.coral, C.violet][i % 4];
    P(cup, Cyl(0.75, 0.3, 0.9, 12), cc, [0, 0.45, 0], [0, 0, 0], { ol: 0.04 });
    P(cup, Cyl(0.35, 0.45, 0.2, 12), cc, [0, 0, 0], [0, 0, 0], { ol: 0.03 });
    trophies.push({ col, cup });
  }
  ([[-2.4, 1.6, C.silver], [0, 2.4, C.sun], [2.4, 1.2, C.bronze]] as [number, number, string][]).forEach(([x, h, c]) =>
    P(park, Box(2.2, h, 2.2), c, [x, 0.3 + h / 2, 1.6], [0, 0, 0], { ol: 0.07 }),
  );

  // podium: the current top three, each with their own look and dance
  const PODIUM = [[0, 2.7], [-2.4, 1.9], [2.4, 1.5]];
  const board = () => snap.stats?.leaderboard ?? [];
  let snap = snap0;
  const avatars = PODIUM.map(([x, y], i) => {
    const b = board()[i];
    const rig = makeAvatar(kit, b ? cfgFor(b.player, b.callsign, i) : cfgFor("0x" + i, "", i));
    rig.root.position.set(x, y, 1.6);
    rig.root.scale.setScalar(1.6);
    rig.root.visible = !!b;
    park.add(rig.root);
    return { rig, y, who: b?.player ?? "" };
  });
  // you: standing in the plaza by the fountain until you win
  const mine = makeAvatar(kit, snap0.avatar);
  const MINE_HOME = (() => {
    const [x, z] = polar(150, 12);
    return new THREE.Vector3(x, G + 0.45, z);
  })();
  mine.root.position.copy(MINE_HOME);
  mine.root.scale.setScalar(1.5);
  ctx.scene.add(mine.root);
  let mineFace = Math.atan2(MINE_HOME.x, MINE_HOME.z);
  const mineRing = P(ctx.scene, new THREE.RingGeometry(1.3, 1.6, 40).rotateX(-Math.PI / 2), basic(C.sun, { transparent: true, opacity: 0.9 }), [MINE_HOME.x, G + 0.5, MINE_HOME.z], [0, 0, 0], { ol: false, shadow: false });

  let leadersKey = "";
  function updatePodium(s: IslandSnap) {
    const b = s.stats?.leaderboard ?? [];
    const k = b.map((x) => `${x.player}:${x.callsign}:${x.earnedUnits}`).join("|");
    if (k === leadersKey) return;
    leadersKey = k;
    avatars.forEach((a, i) => {
      const e = b[i];
      a.rig.root.visible = !!e;
      if (e && (a.who !== e.player || a.rig.cfg.name !== e.callsign)) {
        a.who = e.player;
        a.rig.set(cfgFor(e.player, e.callsign, i));
      }
    });
    const max = b.length ? Number(BigInt(b[0].earnedUnits) / 10_000n) || 1 : 1;
    trophies.forEach((p, i) => {
      const e = b[i];
      const h = e ? 1 + (5 * (Number(BigInt(e.earnedUnits) / 10_000n))) / max : 1;
      p.col.scale.y = h;
      p.col.position.y = h / 2;
      p.cup.position.y = h;
      p.cup.visible = !!e;
    });
  }
  updatePodium(snap0);
  place(ctx, park, LAYOUT.park[0], LAYOUT.park[1]);

  const parkPos = new THREE.Vector3();
  park.getWorldPosition(parkPos);
  const parkRy = Math.atan2(-parkPos.x, -parkPos.z);
  let stage: { until: number } | null = null;
  let dance = 0.6;
  let lastAvatar: AvatarCfg = snap0.avatar;

  ctx.onFrame.push((dt, t, s, ms) => {
    snap = s;
    updatePodium(s);
    if (s.avatar !== lastAvatar) {
      lastAvatar = s.avatar;
      mine.set(s.avatar);
    }
    dance += (0.6 - dance) * dt * 0.35;
    const podK = Math.min(1.1, 0.35 + (dance - 0.6) * 0.45);
    avatars.forEach((a, i) => {
      if (!a.who) return;
      a.rig.root.visible = !(stage && i === 0);
      pose(a.rig, a.rig.cfg.dance, t + i * 0.7, podK);
    });
    if (stage && ms > stage.until) endVictory();
    if (stage) {
      pose(mine, mine.cfg.dance, t, 1.1, parkRy);
      (mineRing.material as THREE.MeshBasicMaterial).opacity = 0;
    } else {
      // idle groove in the plaza: a hint of your dance every few seconds
      const groove = t % 7 < 2.2 ? 0.45 : 0.12;
      const cam = ctx.camera.position;
      const want = Math.atan2(cam.x - mine.root.position.x, cam.z - mine.root.position.z);
      let dRy = want - mineFace;
      dRy = Math.atan2(Math.sin(dRy), Math.cos(dRy));
      mineFace += dRy * Math.min(1, dt * 3);
      pose(mine, groove > 0.2 ? mine.cfg.dance : "idle", t, groove, mineFace);
      (mineRing.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.35 * Math.sin(t * 3);
      mineRing.scale.setScalar(1 + 0.06 * Math.sin(t * 3));
    }
  });

  /** Put you on the top step for about 11 s; returns where the camera should look. */
  function startVictory(): THREE.Vector3 {
    const spot = new THREE.Vector3();
    avatars[0].rig.root.getWorldPosition(spot);
    // the top step even when nobody holds it yet
    if (!avatars[0].who) park.localToWorld(spot.set(PODIUM[0][0], PODIUM[0][1], 1.6));
    stage = { until: performance.now() + 11000 };
    mine.root.position.copy(spot);
    mine.root.scale.setScalar(1.6);
    mine.root.rotation.y = parkRy;
    pose(mine, mine.cfg.dance, 0, 1.1, parkRy);
    dance = 2.6;
    return spot;
  }
  function endVictory() {
    stage = null;
    mine.root.position.copy(MINE_HOME);
    mine.root.scale.setScalar(1.5);
  }
  return {
    park,
    mine,
    parkPos,
    startVictory,
    onStage: () => !!stage,
    celebrate: () => {
      dance = 2.6;
    },
  };
}
export type ParkHandle = ReturnType<typeof buildPark>;
export type { Rig };
