// Ocean: a vertex-waved plane coloured by distance to the nearest shore, with shore foam and rings.
import * as THREE from "three";
import { seaDeep, seaFoam, seaMid, seaShallow } from "@/lib/theme";
import { DECOR, ISLET, ISLET_PH, LH, SUN_DIR, type Ctx } from "./common";

export function buildWater(ctx: Ctx) {
  const water = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(seaShallow) },
        uMid: { value: new THREE.Color(seaMid) },
        uDeep: { value: new THREE.Color(seaDeep) },
        uFoam: { value: new THREE.Color(seaFoam) },
        uSun: { value: SUN_DIR.clone() },
        uIsles: {
          value: [
            new THREE.Vector4(0, 0, 67, 0),
            new THREE.Vector4(ISLET[0], ISLET[1], 20.5, ISLET_PH),
            new THREE.Vector4(DECOR[0], DECOR[1], 9.4, 2.2),
            new THREE.Vector4(LH[0], LH[1], 9.4, 3.1),
          ],
        },
      },
    ]),
    vertexShader: `uniform float uTime; varying vec3 vW;
      #include <fog_pars_vertex>
      void main(){ vec4 w = modelMatrix * vec4(position, 1.);
        w.y += sin(w.x*.055 + uTime*.9)*.32 + cos(w.z*.05 + uTime*.7)*.32 + sin((w.x+w.z)*.11 + uTime*1.4)*.12;
        vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `uniform float uTime; uniform vec3 uShallow; uniform vec3 uMid; uniform vec3 uDeep; uniform vec3 uFoam; uniform vec3 uSun; uniform vec4 uIsles[4]; varying vec3 vW;
      #include <common>
      #include <fog_pars_fragment>
      float wk(float a, float p){ return 1. + .07*sin(3.*a+.5+p) + .04*sin(5.*a+2.+p*2.) + .02*sin(11.*a+p*3.); }
      void main(){
        float d = 1e4;
        for (int i = 0; i < 4; i++) { vec2 q = vW.xz - uIsles[i].xy; float a = atan(q.y, q.x); d = min(d, length(q) - uIsles[i].z * wk(a, uIsles[i].w)); }
        vec3 n = normalize(cross(dFdx(vW), dFdy(vW))); n *= sign(n.y);
        vec3 L = normalize(uSun); float lam = clamp(dot(n, L), 0., 1.);
        vec3 col = mix(uShallow, uMid, smoothstep(0., 20., d)); col = mix(col, uDeep, smoothstep(20., 160., d));
        col *= .84 + .24 * lam;
        vec3 V = normalize(cameraPosition - vW); float spec = pow(max(dot(reflect(-L, n), V), 0.), 90.);
        col += step(.45, spec) * .4;
        float foam = 1. - smoothstep(0., 1.4 + .5*sin(uTime*1.3 + vW.x*.2 + vW.z*.13), d);
        float ring = smoothstep(.82, .97, sin(d*.7 - uTime*1.5)) * (1. - smoothstep(1., 15., d)) * step(0., d);
        col = mix(col, uFoam, clamp(foam + ring*.55, 0., 1.));
        gl_FragColor = vec4(col, 1.);
        #include <fog_fragment>
      }`,
  });
  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600, 300, 300).rotateX(-Math.PI / 2), water);
  ocean.position.y = 0.55;
  ctx.scene.add(ocean);
  ctx.onFrame.push((_dt, t) => {
    water.uniforms.uTime.value = ctx.reduceMotion ? 0 : t;
  });
}
