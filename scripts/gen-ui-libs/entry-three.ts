import * as THREE from "three";
(globalThis as any).THREE = THREE;
// Widgets use `import * as THREE from "three"` — the namespace must carry
// the library's named exports (Scene, Mesh, WebGLRenderer, ...), not just a
// default.
export * from "three";
export default THREE;
