import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

const ThreeBundle = {
  ...THREE,
  OrbitControls,
  RoomEnvironment,
  RoundedBoxGeometry,
};

(globalThis as any).THREE = ThreeBundle;
// Widgets use `import * as THREE from "three"`, `import { OrbitControls } from "three"`,
// or standard `three/addons/...` / `three/examples/jsm/...` aliases — all map to this
// bundle so named, namespace, default and global access all work offline.
export * from "three";
export { OrbitControls, RoomEnvironment, RoundedBoxGeometry };
export default ThreeBundle;
