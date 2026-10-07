// The main island, the Dojo islet, two sand bars, and meadow patches on the grass.
import * as THREE from "three";
import { Cyl } from "./materials";
import { ISLAND } from "@/lib/theme";
import { DECOR, G, GRASS, ISLET, ISLET_PH, LH, SAND, SAND_Y, f, warp, type Ctx } from "./common";

export function buildTerrain(ctx: Ctx) {
  const { P } = ctx.kit;
  const R = ctx.R;
  function island(cx: number, cz: number, rSand: number, rGrass: number, ph: number) {
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);
    ctx.scene.add(g);
    P(g, warp(Cyl(rSand, rSand + 6, 6, 96, 1), ph), SAND, [0, SAND_Y - 3, 0], [0, 0, 0], { ol: false });
    if (rGrass) P(g, warp(Cyl(rGrass, rGrass + 1.5, 1.4, 96, 1), ph), GRASS, [0, G - 0.7, 0], [0, 0, 0], { ol: 0.14 });
    return g;
  }
  island(0, 0, 66, 57, 0);
  island(ISLET[0], ISLET[1], 20, 15.5, ISLET_PH);
  island(DECOR[0], DECOR[1], 9, 0, 2.2);
  island(LH[0], LH[1], 9, 0, 3.1);
  // meadow patches give the grass some variety
  for (let i = 0; i < 16; i++) {
    const a = R() * Math.PI * 2;
    const r = 18 + R() * 34;
    if (r > 52 * f(a)) continue;
    const m = P(
      ctx.scene,
      warp(new THREE.CircleGeometry(3 + R() * 4, 18).rotateX(-Math.PI / 2), R() * 6),
      R() < 0.5 ? ISLAND.meadow : ISLAND.meadowDark,
      [r * Math.cos(a), G + 0.015, r * Math.sin(a)],
      [0, 0, 0],
      { ol: false, shadow: false },
    );
    m.renderOrder = 1;
  }
}
