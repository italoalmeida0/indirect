import * as CANNON from "cannon-es";

(globalThis as any).CANNON = CANNON;

// Widgets use `import * as CANNON from "cannon-es"` or named imports.
// Expose the library's named surface as well as default.
export * from "cannon-es";
export default CANNON;
