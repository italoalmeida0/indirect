// The package `main` is a UMD build with a single default export; the ESM
// build carries the documented named surface (map, marker, tileLayer, ...).
// Widgets use `import * as L from "leaflet"` and call `L.map(...)`, so the
// namespace must carry those members — and the ESM build has no default at
// all, so the "default" is that namespace itself.
import * as Leaflet from "leaflet/dist/leaflet-src.esm.js";
(globalThis as any).L = Leaflet;
export * from "leaflet/dist/leaflet-src.esm.js";
export default Leaflet;
