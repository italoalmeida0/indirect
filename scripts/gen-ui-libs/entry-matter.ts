import * as matterNs from "matter-js";

const Matter: any = (matterNs as any).default ?? matterNs;
(globalThis as any).Matter = Matter;

// The Matter.js module is historically CommonJS/UMD. To ensure both
// `import Matter from "matter-js"`, `import * as Matter from "matter-js"`, and
// `import { Engine, Bodies, Composite } from "matter-js"` work reliably in ESM
// widget code, we re-export all members explicitly as named exports.
export const {
  Axes,
  Bodies,
  Body,
  Bounds,
  Collision,
  Common,
  Composite,
  Composites,
  Constraint,
  Contact,
  Detector,
  Engine,
  Events,
  Grid,
  Mouse,
  MouseConstraint,
  Pair,
  Pairs,
  Plugin,
  Query,
  Render,
  Resolver,
  Runner,
  SAT,
  Sleeping,
  Svg,
  Vector,
  Vertices,
  World,
} = Matter;

export default Matter;
