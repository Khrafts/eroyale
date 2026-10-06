// Gradient sky dome with a soft sun disc.
import * as THREE from "three";
import { HORIZON, SUN_DIR } from "./common";

export function buildSky(scene: THREE.Scene) {
  scene.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(1400, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { top: { value: new THREE.Color("#5B7CFA") }, mid: { value: new THREE.Color("#B3BEFF") }, bot: { value: new THREE.Color(HORIZON) }, sun: { value: SUN_DIR } },
        vertexShader: "varying vec3 vP; void main(){ vP = (modelMatrix*vec4(position,1.)).xyz; gl_Position = projectionMatrix*viewMatrix*vec4(vP,1.); }",
        fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bot; uniform vec3 sun; varying vec3 vP;
      void main(){ vec3 d = normalize(vP); float h = d.y;
        vec3 c = mix(mid, top, smoothstep(0.05, 0.55, h)); c = mix(bot, c, smoothstep(-0.02, 0.2, h));
        float s = max(dot(d, normalize(sun)), 0.); c += vec3(1., .85, .6) * (pow(s, 40.) * .5 + step(.9985, s) * .6);
        gl_FragColor = vec4(c, 1.); }`,
      }),
    ),
  );
}
