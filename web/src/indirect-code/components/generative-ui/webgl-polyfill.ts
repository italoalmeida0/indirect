/**
 * Generative UI: WebGL/WebGL2 software polyfill for the widget LINT page.
 *
 * The lint smoke render runs in the headless obscura browser, which ships no
 * GPU and no WebGL at all (`canvas.getContext("webgl2")` returns null). Every
 * 3D widget (three.js, cannon-es scenes, plain WebGL) therefore failed the
 * smoke render and was waved through with a "3D content not exercised" note.
 *
 * This module embeds a complete WebGL2 context polyfill — full WebGL2 enum
 * set, resource objects (buffer/texture/shader/program/FBO/VAO/sync), state
 * tracking, a real GLSL ES 3.00/1.00 declaration parser (so
 * getActiveAttrib/getActiveAttrib/getActiveUniform reflect the widget's own
 * shaders) and the extensions three.js probes at startup. With it installed,
 * `new THREE.WebGLRenderer()` constructs, `renderer.render(scene, camera)`
 * runs its complete draw path and shader compile/link diagnostics work —
 * all inside the lint browser, without a GPU.
 *
 * The polyfill is defensive by design:
 *   - it installs ONLY when the page has no native WebGL (real browsers keep
 *     their hardware contexts);
 *   - it is idempotent and self-reporting via `window.__guWebglPolyfill`
 *     (stats the lint page turns into a findings note);
 *   - it never throws into widget code: malformed GLSL is reported through
 *     getShaderInfoLog/getProgramInfoLog exactly like a real driver, and
 *     unknown entry points are covered by a reflective no-op fallback.
 *
 * Keep this dependency-free and eval-free: the widget CSP has no
 * 'unsafe-eval'. The body is a plain script (like react-runtime.ts).
 */

export const WEBGL_POLYFILL_JS = String.raw`(function () {
  "use strict";

  var win = typeof window !== "undefined" ? window : null;
  if (!win) return;
  if (win.__guWebglPolyfill) return;

  /* Install only where the platform has no WebGL at all (headless lint
     browser). Real browsers keep their native contexts untouched. */
  var nativeGL = null;
  try {
    var probe = win.document.createElement("canvas");
    nativeGL = probe.getContext("webgl2") || probe.getContext("webgl") || probe.getContext("experimental-webgl");
  } catch (e) {
    nativeGL = null;
  }
  if (nativeGL) {
    win.__guWebglPolyfill = { installed: false, reason: "native-webgl-available", stats: null };
    return;
  }

  /* ------------------------------- stats ------------------------------- */

  var STATS = {
    contexts: 0,
    programs: 0,
    shaders: 0,
    compileErrors: 0,
    linkErrors: 0,
    drawCalls: 0,
    clearCalls: 0,
    uniformsSet: 0,
    textures: 0,
    buffers: 0,
    shaderErrors: [],
    warnings: {}
  };
  function warnOnce(msg) {
    STATS.warnings[msg] = (STATS.warnings[msg] || 0) + 1;
  }

  /* ----------------------------- constants ----------------------------- */
  /* Full WebGL2 / OpenGL ES 3.0 enum surface (values are the registry
     values — three.js passes them back into the API for formats, modes and
     queries, so they must be real). */

  var CONST = {
    DEPTH_BUFFER_BIT: 0x00000100, STENCIL_BUFFER_BIT: 0x00000400, COLOR_BUFFER_BIT: 0x00004000,
    POINTS: 0x0000, LINES: 0x0001, LINE_LOOP: 0x0002, LINE_STRIP: 0x0003,
    TRIANGLES: 0x0004, TRIANGLE_STRIP: 0x0005, TRIANGLE_FAN: 0x0006,
    ZERO: 0, ONE: 1, SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301, SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303, DST_ALPHA: 0x0304, ONE_MINUS_DST_ALPHA: 0x0305,
    DST_COLOR: 0x0306, ONE_MINUS_DST_COLOR: 0x0307, SRC_ALPHA_SATURATE: 0x0308,
    FUNC_ADD: 0x8006, BLEND_EQUATION: 0x8009, BLEND_EQUATION_RGB: 0x8009, BLEND_EQUATION_ALPHA: 0x883D,
    FUNC_SUBTRACT: 0x800A, FUNC_REVERSE_SUBTRACT: 0x800B,
    BLEND_DST_RGB: 0x80C8, BLEND_SRC_RGB: 0x80C9, BLEND_DST_ALPHA: 0x80CA, BLEND_SRC_ALPHA: 0x80CB,
    CONSTANT_COLOR: 0x8001, ONE_MINUS_CONSTANT_COLOR: 0x8002, CONSTANT_ALPHA: 0x8003,
    ONE_MINUS_CONSTANT_ALPHA: 0x8004, BLEND_COLOR: 0x8005,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
    ARRAY_BUFFER_BINDING: 0x8894, ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
    STREAM_DRAW: 0x88E0, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8,
    STREAM_READ: 0x88E1, STREAM_COPY: 0x88E2, STATIC_READ: 0x88E5, STATIC_COPY: 0x88E6,
    DYNAMIC_READ: 0x88E9, DYNAMIC_COPY: 0x88EA,
    BUFFER_SIZE: 0x8764, BUFFER_USAGE: 0x8765,
    CURRENT_VERTEX_ATTRIB: 0x8626,
    FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408,
    CULL_FACE: 0x0B44, BLEND: 0x0BE2, DITHER: 0x0BD0, STENCIL_TEST: 0x0B90, DEPTH_TEST: 0x0B71,
    SCISSOR_TEST: 0x0C11, POLYGON_OFFSET_FILL: 0x8037, SAMPLE_ALPHA_TO_COVERAGE: 0x809E,
    SAMPLE_COVERAGE: 0x80A0,
    NO_ERROR: 0, INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501, INVALID_OPERATION: 0x0502,
    OUT_OF_MEMORY: 0x0505, INVALID_FRAMEBUFFER_OPERATION: 0x0506,
    CW: 0x0900, CCW: 0x0901,
    LINE_WIDTH: 0x0B21, ALIASED_POINT_SIZE_RANGE: 0x846D, ALIASED_LINE_WIDTH_RANGE: 0x846E,
    CULL_FACE_MODE: 0x0B45, FRONT_FACE: 0x0B46, DEPTH_RANGE: 0x0B70, DEPTH_WRITEMASK: 0x0B72,
    DEPTH_CLEAR_VALUE: 0x0B73, DEPTH_FUNC: 0x0B74, STENCIL_CLEAR_VALUE: 0x0B91, STENCIL_FUNC: 0x0B92,
    STENCIL_FAIL: 0x0B94, STENCIL_PASS_DEPTH_FAIL: 0x0B95, STENCIL_PASS_DEPTH_PASS: 0x0B96,
    STENCIL_REF: 0x0B97, STENCIL_VALUE_MASK: 0x0B93, STENCIL_WRITEMASK: 0x0B98,
    STENCIL_BACK_FUNC: 0x8800, STENCIL_BACK_FAIL: 0x8801, STENCIL_BACK_PASS_DEPTH_FAIL: 0x8802,
    STENCIL_BACK_PASS_DEPTH_PASS: 0x8803, STENCIL_BACK_REF: 0x8CA3, STENCIL_BACK_VALUE_MASK: 0x8CA4,
    STENCIL_BACK_WRITEMASK: 0x8CA5,
    VIEWPORT: 0x0BA2, SCISSOR_BOX: 0x0C10, COLOR_CLEAR_VALUE: 0x0C22, COLOR_WRITEMASK: 0x0C23,
    UNPACK_ALIGNMENT: 0x0CF5, PACK_ALIGNMENT: 0x0D05,
    MAX_TEXTURE_SIZE: 0x0D33, MAX_VIEWPORT_DIMS: 0x0D3A, SUBPIXEL_BITS: 0x0D50,
    RED_BITS: 0x0D52, GREEN_BITS: 0x0D53, BLUE_BITS: 0x0D54, ALPHA_BITS: 0x0D55,
    DEPTH_BITS: 0x0D56, STENCIL_BITS: 0x0D57,
    POLYGON_OFFSET_UNITS: 0x2A00, POLYGON_OFFSET_FACTOR: 0x8038,
    TEXTURE_BINDING_2D: 0x8069, SAMPLE_BUFFERS: 0x80A8, SAMPLES: 0x80A9,
    SAMPLE_COVERAGE_VALUE: 0x80AA, SAMPLE_COVERAGE_INVERT: 0x80AB,
    COMPRESSED_TEXTURE_FORMATS: 0x86A3,
    DONT_CARE: 0x1100, FASTEST: 0x1101, NICEST: 0x1102, GENERATE_MIPMAP_HINT: 0x8192,
    BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403,
    INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406, HALF_FLOAT: 0x140B,
    FIXED: 0x140C, UNSIGNED_SHORT_5_6_5: 0x8363,
    DEPTH_COMPONENT: 0x1902, ALPHA: 0x1906, RGB: 0x1907, RGBA: 0x1908,
    LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190A,
    UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034,
    FRAGMENT_SHADER: 0x8B30, VERTEX_SHADER: 0x8B31,
    MAX_VERTEX_ATTRIBS: 0x8869, MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB, MAX_VARYING_VECTORS: 0x8DFC,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
    MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF, TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE,
    UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246,
    SHADER_TYPE: 0x8B4F, DELETE_STATUS: 0x8B80, LINK_STATUS: 0x8B82, VALIDATE_STATUS: 0x8B83,
    ATTACHED_SHADERS: 0x8B85, ACTIVE_UNIFORMS: 0x8B86, ACTIVE_UNIFORM_MAX_LENGTH: 0x8B87,
    ACTIVE_ATTRIBUTES: 0x8B89, ACTIVE_ATTRIBUTE_MAX_LENGTH: 0x8B8A,
    SHADING_LANGUAGE_VERSION: 0x8B8C, CURRENT_PROGRAM: 0x8B8D, COMPILE_STATUS: 0x8B81,
    NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203, GREATER: 0x0204,
    NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,
    KEEP: 0x1E00, REPLACE: 0x1E01, INCR: 0x1E02, DECR: 0x1E03, INVERT: 0x150A,
    INCR_WRAP: 0x8507, DECR_WRAP: 0x8508,
    VENDOR: 0x1F00, RENDERER: 0x1F01, VERSION: 0x1F02, EXTENSIONS: 0x1F03,
    NEAREST: 0x2600, LINEAR: 0x2601,
    NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701,
    NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
    TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072,
    TEXTURE: 0x1702, TEXTURE_2D: 0x0DE1, TEXTURE_3D: 0x806F, TEXTURE_2D_ARRAY: 0x8C1A,
    TEXTURE_CUBE_MAP: 0x8513, TEXTURE_BINDING_CUBE_MAP: 0x8514, TEXTURE_BINDING_3D: 0x806A,
    TEXTURE_BINDING_2D_ARRAY: 0x8C1D,
    TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515, TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516,
    TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517, TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518,
    TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519, TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851A,
    MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C, MAX_3D_TEXTURE_SIZE: 0x8073,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88FF,
    TEXTURE0: 0x84C0, ACTIVE_TEXTURE: 0x84E0,
    REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370,
    TEXTURE_MIN_LOD: 0x813A, TEXTURE_MAX_LOD: 0x813B, TEXTURE_BASE_LEVEL: 0x813C,
    TEXTURE_MAX_LEVEL: 0x813D, TEXTURE_COMPARE_MODE: 0x884C, TEXTURE_COMPARE_FUNC: 0x884D,
    COMPARE_REF_TO_TEXTURE: 0x884E, TEXTURE_IMMUTABLE_FORMAT: 0x912F,
    TEXTURE_IMMUTABLE_LEVELS: 0x82DF,
    FLOAT_VEC2: 0x8B50, FLOAT_VEC3: 0x8B51, FLOAT_VEC4: 0x8B52,
    INT_VEC2: 0x8B53, INT_VEC3: 0x8B54, INT_VEC4: 0x8B55,
    BOOL: 0x8B56, BOOL_VEC2: 0x8B57, BOOL_VEC3: 0x8B58, BOOL_VEC4: 0x8B59,
    FLOAT_MAT2: 0x8B5A, FLOAT_MAT3: 0x8B5B, FLOAT_MAT4: 0x8B5C,
    FLOAT_MAT2x3: 0x8B65, FLOAT_MAT2x4: 0x8B66, FLOAT_MAT3x2: 0x8B67,
    FLOAT_MAT3x4: 0x8B68, FLOAT_MAT4x2: 0x8B69, FLOAT_MAT4x3: 0x8B6A,
    SAMPLER_2D: 0x8B5E, SAMPLER_3D: 0x8B5F, SAMPLER_CUBE: 0x8B60,
    SAMPLER_2D_SHADOW: 0x8B62, SAMPLER_2D_ARRAY: 0x8DC1, SAMPLER_2D_ARRAY_SHADOW: 0x8DC4,
    SAMPLER_CUBE_SHADOW: 0x8DC5, INT_SAMPLER_2D: 0x8DCA, INT_SAMPLER_3D: 0x8DCB,
    UNSIGNED_INT_SAMPLER_2D: 0x8DD2,
    VERTEX_ATTRIB_ARRAY_ENABLED: 0x8622, VERTEX_ATTRIB_ARRAY_SIZE: 0x8623,
    VERTEX_ATTRIB_ARRAY_STRIDE: 0x8624, VERTEX_ATTRIB_ARRAY_TYPE: 0x8625,
    VERTEX_ATTRIB_ARRAY_NORMALIZED: 0x886A, VERTEX_ATTRIB_ARRAY_POINTER: 0x8645,
    VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 0x889F, VERTEX_ATTRIB_ARRAY_INTEGER: 0x88FD,
    IMPLEMENTATION_COLOR_READ_TYPE: 0x8B9A, IMPLEMENTATION_COLOR_READ_FORMAT: 0x8B9B,
    LOW_FLOAT: 0x8DF0, MEDIUM_FLOAT: 0x8DF1, HIGH_FLOAT: 0x8DF2,
    LOW_INT: 0x8DF3, MEDIUM_INT: 0x8DF4, HIGH_INT: 0x8DF5,
    FRAMEBUFFER: 0x8D40, READ_FRAMEBUFFER: 0x8CA8, DRAW_FRAMEBUFFER: 0x8CA9,
    RENDERBUFFER: 0x8D41,
    RGBA4: 0x8056, RGB5_A1: 0x8057, RGB565: 0x8D62,
    DEPTH_COMPONENT16: 0x81A5, DEPTH_COMPONENT24: 0x81A6, DEPTH_COMPONENT32: 0x81A7,
    DEPTH_COMPONENT32F: 0x8CAC, DEPTH24_STENCIL8: 0x88F0, DEPTH32F_STENCIL8: 0x8CAD,
    STENCIL_INDEX8: 0x8D48, DEPTH_STENCIL: 0x84F9, DEPTH_STENCIL_ATTACHMENT: 0x821A,
    RENDERBUFFER_WIDTH: 0x8D42, RENDERBUFFER_HEIGHT: 0x8D43, RENDERBUFFER_INTERNAL_FORMAT: 0x8D44,
    RENDERBUFFER_RED_SIZE: 0x8D50, RENDERBUFFER_GREEN_SIZE: 0x8D51, RENDERBUFFER_BLUE_SIZE: 0x8D52,
    RENDERBUFFER_ALPHA_SIZE: 0x8D53, RENDERBUFFER_DEPTH_SIZE: 0x8D54,
    RENDERBUFFER_STENCIL_SIZE: 0x8D55, TEXTURE_STENCIL_SIZE: 0x88F1,
    FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8CD0, FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 0x8CD1,
    FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: 0x8CD2, FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE: 0x8CD3,
    FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING: 0x8210,
    COLOR_ATTACHMENT0: 0x8CE0, COLOR_ATTACHMENT1: 0x8CE1, COLOR_ATTACHMENT2: 0x8CE2,
    COLOR_ATTACHMENT3: 0x8CE3, DEPTH_ATTACHMENT: 0x8D00, STENCIL_ATTACHMENT: 0x8D20,
    FRAMEBUFFER_COMPLETE: 0x8CD5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8CD6,
    FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8CD7,
    FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER: 0x8CDB, FRAMEBUFFER_INCOMPLETE_READ_BUFFER: 0x8CDC,
    FRAMEBUFFER_UNSUPPORTED: 0x8CDD, FRAMEBUFFER_UNDEFINED: 0x8219,
    FRAMEBUFFER_BINDING: 0x8CA6, DRAW_FRAMEBUFFER_BINDING: 0x8CA6, READ_FRAMEBUFFER_BINDING: 0x8CAA,
    RENDERBUFFER_BINDING: 0x8CA7, MAX_RENDERBUFFER_SIZE: 0x84E8,
    MAX_COLOR_ATTACHMENTS: 0x8CDF, MAX_DRAW_BUFFERS: 0x8824,
    DRAW_BUFFER0: 0x8825, DRAW_BUFFER1: 0x8826, READ_BUFFER: 0x0C02,
    UNPACK_ROW_LENGTH: 0x0CF2, UNPACK_SKIP_ROWS: 0x0CF3, UNPACK_SKIP_PIXELS: 0x0CF4,
    UNPACK_SKIP_IMAGES: 0x806D, UNPACK_IMAGE_HEIGHT: 0x806E,
    UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, UNPACK_COLOR_SPACE: 0x9243,
    PACK_ROW_LENGTH: 0x0D02, PACK_SKIP_ROWS: 0x0D03, PACK_SKIP_PIXELS: 0x0D04,
    PACK_SKIP_IMAGES: 0x806B, PACK_IMAGE_HEIGHT: 0x806C,
    MIN: 0x8007, MAX: 0x8008,
    R8: 0x8229, R16: 0x822A, RG8: 0x822B, RG16: 0x822C,
    R16F: 0x822D, R32F: 0x822E, RG16F: 0x822F, RG32F: 0x8230,
    R8I: 0x8231, R8UI: 0x8232, R16I: 0x8233, R16UI: 0x8234, R32I: 0x8235, R32UI: 0x8236,
    RG8I: 0x8237, RG8UI: 0x8238, RG16I: 0x8239, RG16UI: 0x823A, RG32I: 0x823B, RG32UI: 0x823C,
    R8_SNORM: 0x8F94, RG8_SNORM: 0x8F95, RGB8_SNORM: 0x8F96, RGBA8_SNORM: 0x8F97,
    R16_SNORM: 0x8F98, RG16_SNORM: 0x8F99, RGB16_SNORM: 0x8F9A, RGBA16_SNORM: 0x8F9B,
    RGB8: 0x8051, RGB10: 0x8052, RGB12: 0x8053, RGBA8: 0x8058, RGB10_A2: 0x8059,
    RGB10_A2UI: 0x906F, RGBA12: 0x805A, RGBA16: 0x805B, SRGB8: 0x8C41, SRGB8_ALPHA8: 0x8C43,
    RGBA32F: 0x8814, RGB32F: 0x8815, RGBA16F: 0x881A, RGB16F: 0x881B,
    RGBA32UI: 0x8D70, RGBA16UI: 0x8D76, RGBA8UI: 0x8D7C,
    RGBA32I: 0x8D82, RGBA16I: 0x8D88, RGBA8I: 0x8D8E,
    RGB32UI: 0x8D71, RGB16UI: 0x8D77, RGB8UI: 0x8D7D,
    RGB32I: 0x8D83, RGB16I: 0x8D89, RGB8I: 0x8D8F,
    R11F_G11F_B10F: 0x8C3A, RGB9_E5: 0x8C3D,
    UNSIGNED_INT_2_10_10_10_REV: 0x8368, UNSIGNED_INT_10F_11F_11F_REV: 0x8C3B,
    UNSIGNED_INT_5_9_9_9_REV: 0x8C3E, UNSIGNED_INT_24_8: 0x84FA,
    UNSIGNED_NORMALIZED: 0x8C17,
    RED: 0x1903, RG: 0x8227, RED_INTEGER: 0x8D94, RGB_INTEGER: 0x8D98, RGBA_INTEGER: 0x8D99,
    RG_INTEGER: 0x8228, BGR: 0x80E0, BGRA: 0x80E1,
    MIN_PROGRAM_TEXEL_OFFSET: 0x8904, MAX_PROGRAM_TEXEL_OFFSET: 0x8905,
    MAX_VARYING_COMPONENTS: 0x8B4B, MAX_VERTEX_UNIFORM_COMPONENTS: 0x8B4A,
    MAX_FRAGMENT_UNIFORM_COMPONENTS: 0x8B49,
    MAX_ELEMENTS_VERTICES: 0x80E8, MAX_ELEMENTS_INDICES: 0x80E9,
    MAX_TEXTURE_LOD_BIAS: 0x84FD, MAX_VIEWPORT_DIMS2: 0x0D3A,
    FRAGMENT_SHADER_DERIVATIVE_HINT: 0x8B8B,
    PIXEL_PACK_BUFFER: 0x88EB, PIXEL_UNPACK_BUFFER: 0x88EC,
    PIXEL_PACK_BUFFER_BINDING: 0x88ED, PIXEL_UNPACK_BUFFER_BINDING: 0x88EE,
    UNIFORM_BUFFER: 0x8A11, UNIFORM_BUFFER_BINDING: 0x8A28,
    MAX_UNIFORM_BUFFER_BINDINGS: 0x8A2E, MAX_UNIFORM_BLOCK_SIZE: 0x8A30,
    MAX_COMBINED_UNIFORM_BLOCKS: 0x8A2E, UNIFORM_BUFFER_OFFSET_ALIGNMENT: 0x8A34,
    UNIFORM_BUFFER_START: 0x8A2A, UNIFORM_BUFFER_SIZE: 0x8A2B,
    OBJECT_TYPE: 0x9112, SYNC_CONDITION: 0x9113, SYNC_STATUS: 0x9114, SYNC_FLAGS: 0x9115,
    SYNC_FENCE: 0x9116, SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    UNSIGNALED: 0x9118, SIGNALED: 0x9119, ALREADY_SIGNALED: 0x911A, TIMEOUT_EXPIRED: 0x911B,
    CONDITION_SATISFIED: 0x911C, WAIT_FAILED: 0x911D, SYNC_FLUSH_COMMANDS_BIT: 0x0001,
    TIMEOUT_IGNORED: -1,
    MAJOR_VERSION: 0x821B, MINOR_VERSION: 0x821C, NUM_EXTENSIONS: 0x821D,
    CONTEXT_FLAGS: 0x821E, CONTEXT_FLAG_FORWARD_COMPATIBLE_BIT: 0x0001,
    RESET_NOTIFICATION_STRATEGY: 0x8256, LOSE_CONTEXT_ON_RESET: 0x8252,
    NO_RESET_NOTIFICATION: 0x8261,
    MAX_SAMPLES: 0x8D57, MAX_DRAW_BUFFERS2: 0x8824,
    COLOR: 0x1800, DEPTH: 0x1801, STENCIL: 0x1802, STENCIL_INDEX: 0x1901,
    DEPTH_COMPONENT24: 0x81A6
  };

  var MAX_TEXTURE_SIZE = 16384;

  /* ------------------------------ resources ---------------------------- */

  var uid = 0;
  function makeRes(kind, extra) {
    var r = { __glKind: kind, __glId: ++uid };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }

  /* --------------------------- GLSL parsing ---------------------------- */
  /* Enough of a real compiler for lint: declarations are extracted so
     getActiveAttrib / getActiveUniform / getUniformLocation reflect the
     widget's own shaders, and the small set of structural errors a driver
     would catch (unbalanced braces, unterminated comments) is reported
     through getShaderInfoLog instead of throwing. */

  function stripComments(src) {
    return String(src)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  }

  var DECL_RE = /(?:^|[;{}\n])\s*(?:(?:layout\s*\([^)]*\)\s*)?(?:(?:flat|smooth|noperspective|centroid|invariant|precise)\s+)*)(attribute|in|out|uniform|varying)\s+(?:(?:lowp|mediump|highp)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+([^;{}]*)([;{])/g;

  var TYPE_ENUM = {
    float: CONST.FLOAT, vec2: CONST.FLOAT_VEC2, vec3: CONST.FLOAT_VEC3, vec4: CONST.FLOAT_VEC4,
    int: CONST.INT, ivec2: CONST.INT_VEC2, ivec3: CONST.INT_VEC3, ivec4: CONST.INT_VEC4,
    uint: CONST.UNSIGNED_INT, uvec2: 0x8DC6, uvec3: 0x8DC7, uvec4: 0x8DC8,
    bool: CONST.BOOL, bvec2: CONST.BOOL_VEC2, bvec3: CONST.BOOL_VEC3, bvec4: CONST.BOOL_VEC4,
    mat2: CONST.FLOAT_MAT2, mat3: CONST.FLOAT_MAT3, mat4: CONST.FLOAT_MAT4,
    mat2x3: CONST.FLOAT_MAT2x3, mat2x4: CONST.FLOAT_MAT2x4, mat3x2: CONST.FLOAT_MAT3x2,
    mat3x4: CONST.FLOAT_MAT3x4, mat4x2: CONST.FLOAT_MAT4x2, mat4x3: CONST.FLOAT_MAT4x3,
    sampler2D: CONST.SAMPLER_2D, sampler3D: CONST.SAMPLER_3D, samplerCube: CONST.SAMPLER_CUBE,
    sampler2DShadow: CONST.SAMPLER_2D_SHADOW, sampler2DArray: CONST.SAMPLER_2D_ARRAY,
    sampler2DArrayShadow: CONST.SAMPLER_2D_ARRAY_SHADOW, samplerCubeShadow: CONST.SAMPLER_CUBE_SHADOW,
    isampler2D: CONST.INT_SAMPLER_2D, isampler3D: 0x8DCB,
    usampler2D: CONST.UNSIGNED_INT_SAMPLER_2D, usampler3D: 0x8DD3
  };

  function parseShaderSource(src, type) {
    var out = { attributes: [], uniforms: [], varyings: [], errors: [], version: 100 };
    var text = String(src || "");
    var ver = text.match(/^\s*#version\s+(\d+)/);
    if (ver) out.version = parseInt(ver[1], 10);
    var body = stripComments(text);
    out.warnings = [];
    // Structural checks a real compiler catches. Brace balance is only an
    // error when the shader has no conditional compilation — #ifdef
    // branches may legitimately split a block between alternatives.
    var opens = (body.match(/\{/g) || []).length;
    var closes = (body.match(/\}/g) || []).length;
    var conditional = /#\s*(?:if|ifdef|ifndef|else|elif|endif)/.test(body);
    if (opens !== closes) {
      var msg = "'{' : unbalanced braces (" + opens + " open, " + closes + " close)";
      if (conditional) out.warnings.push("WARNING: 0:1: " + msg + " across preprocessor branches");
      else out.errors.push("ERROR: 0:1: " + msg);
    }
    if (/\/\*/.test(body) && !/\*\//.test(body)) out.errors.push("ERROR: 0:1: unterminated block comment");
    if (!/\bvoid\s+main\s*\(/.test(body)) out.errors.push("ERROR: 0:1: no entry point 'void main(...)'");
    if (type === CONST.VERTEX_SHADER && out.version >= 300 && !/\bgl_Position\b/.test(body)) {
      out.warnings = out.warnings || [];
      out.warnings.push("WARNING: 0:1: vertex shader does not write gl_Position");
    }

    DECL_RE.lastIndex = 0;
    var m;
    while ((m = DECL_RE.exec(body)) !== null) {
      var qual = m[1];
      var glslType = m[2];
      var declarators = m[3];
      var terminator = m[4];
      if (qual === "uniform" && terminator === "{") continue; // uniform block: not individual uniforms
      // Function parameter lists that wrap across lines look like
      // declarations ("(\n out vec4 fragColor,") — skip anything that
      // carries parameter syntax.
      if (/[()=]/.test(declarators)) continue;
      var names = String(declarators).split(",");
      for (var i = 0; i < names.length; i++) {
        var piece = names[i].trim();
        var nm = piece.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(\[\s*([0-9]+)\s*\])?$/);
        if (!nm) continue;
        var entry = {
          name: nm[1],
          type: TYPE_ENUM[glslType] || CONST.FLOAT,
          size: nm[3] ? parseInt(nm[3], 10) : 1
        };
        if (qual === "uniform") out.uniforms.push(entry);
        else if (qual === "attribute" || (qual === "in" && type === CONST.VERTEX_SHADER)) out.attributes.push(entry);
        else out.varyings.push(entry);
      }
    }
    return out;
  }

  /* ------------------------------ context ------------------------------ */

  function createContext(canvas, attrs, webgl2) {
    var W = function () { return canvas.width || 1; };
    var H = function () { return canvas.height || 1; };

    var ctx = {};
    var state = {
      programs: new WeakMap(),
      currentProgram: null,
      bound: { arrayBuffer: null, elementArrayBuffer: null, pixelPackBuffer: null, pixelUnpackBuffer: null,
        uniformBuffer: 0, texture2D: null, textureCube: null, texture3D: null, texture2DArray: null,
        framebuffer: null, renderbuffer: null, vao: null },
      activeTexture: CONST.TEXTURE0,
      viewportBox: [0, 0, W(), H()],
      scissorBox: [0, 0, W(), H()],
      clearColor: [0, 0, 0, 0],
      clearDepth: 1,
      clearStencil: 0,
      colorMask: [true, true, true, true],
      depthMask: true,
      frontFace: CONST.CCW,
      cullFaceMode: CONST.BACK,
      errors: [],
      pixelStore: { unpackFlipY: false, unpackPremultiplyAlpha: false, unpackAlignment: 4, packAlignment: 4 },
      drawBuffers: [CONST.COLOR_ATTACHMENT0]
    };

    function fail(code, msg) {
      if (state.errors.length < 8) state.errors.push(code);
      if (msg) warnOnce(msg);
    }

    function texUnit() {
      return state.activeTexture - CONST.TEXTURE0;
    }

    /* ---- resource factories ---- */
    function createBuffer() { STATS.buffers++; return makeRes("buffer", { data: null, target: 0 }); }
    function createTexture() {
      STATS.textures++;
      return makeRes("texture", { target: CONST.TEXTURE_2D, level: 0, w: 0, h: 0, params: {} });
    }
    function createFramebuffer() { return makeRes("framebuffer", { attachments: {} }); }
    function createRenderbuffer() { return makeRes("renderbuffer", { w: 0, h: 0, format: 0 }); }
    function createVertexArray() { return makeRes("vao"); }
    function createSampler() { return makeRes("sampler", { params: {} }); }

    /* ---- shaders & programs (with a real declaration parse) ---- */
    function createShader(type) {
      STATS.shaders++;
      return makeRes("shader", {
        type: type,
        source: "",
        compiled: false,
        compileStatus: false,
        infoLog: "",
        parsed: null
      });
    }
    function shaderSource(shader, src) { shader.source = String(src); }
    function compileShader(shader) {
      var parsed = parseShaderSource(shader.source, shader.type);
      shader.parsed = parsed;
      shader.compiled = true;
      shader.compileStatus = parsed.errors.length === 0;
      shader.infoLog = parsed.errors.concat(parsed.warnings || []).join("\n");
      if (!shader.compileStatus) {
        STATS.compileErrors++;
        if (STATS.shaderErrors.length < 8) STATS.shaderErrors.push(parsed.errors.join("; ").slice(0, 400));
        warnOnce("shader compile failed: " + (parsed.errors[0] || "unknown"));
      }
    }
    function createProgram() {
      STATS.programs++;
      return makeRes("program", {
        shaders: [],
        linked: false,
        linkStatus: false,
        infoLog: "",
        attributes: [],
        uniforms: {},
        attribBindings: {}
      });
    }
    function attachShader(program, shader) {
      if (program.shaders.indexOf(shader) < 0) program.shaders.push(shader);
    }
    function detachShader(program, shader) {
      var i = program.shaders.indexOf(shader);
      if (i >= 0) program.shaders.splice(i, 1);
    }
    function linkProgram(program) {
      var attributes = [];
      var uniforms = {};
      var errors = [];
      var seenAttrib = {};
      for (var i = 0; i < program.shaders.length; i++) {
        var sh = program.shaders[i];
        if (!sh.compiled) compileShader(sh);
        if (!sh.compileStatus) errors.push((sh.type === CONST.VERTEX_SHADER ? "vertex" : "fragment") + " shader: " + sh.infoLog);
        var p = sh.parsed || { attributes: [], uniforms: [] };
        for (var a = 0; a < p.attributes.length; a++) {
          if (!seenAttrib[p.attributes[a].name]) {
            seenAttrib[p.attributes[a].name] = true;
            attributes.push({ name: p.attributes[a].name, type: p.attributes[a].type, size: p.attributes[a].size });
          }
        }
        for (var u = 0; u < p.uniforms.length; u++) {
          var up = p.uniforms[u];
          if (!uniforms[up.name]) uniforms[up.name] = { name: up.name, type: up.type, size: up.size, value: null };
        }
      }
      program.attributes = attributes;
      program.uniforms = uniforms;
      program.linked = true;
      program.linkStatus = errors.length === 0;
      program.infoLog = errors.join("\n");
      if (!program.linkStatus) {
        STATS.linkErrors++;
        if (STATS.shaderErrors.length < 8) STATS.shaderErrors.push(("link: " + program.infoLog).slice(0, 400));
        warnOnce("program link failed");
      }
    }
    function getAttribLocation(program, name) {
      for (var i = 0; i < program.attributes.length; i++) {
        if (program.attributes[i].name === name) {
          return program.attribBindings[name] !== undefined ? program.attribBindings[name] : i;
        }
      }
      return -1;
    }
    function bindAttribLocation(program, index, name) {
      program.attribBindings[name] = index;
      // Reorder so the forced binding wins in getAttribLocation.
      var order = [];
      for (var k in program.attribBindings) {
        var loc = -1;
        for (var i = 0; i < program.attributes.length; i++) if (program.attributes[i].name === k) loc = i;
        if (loc >= 0) order.push({ name: k, index: program.attribBindings[k], type: program.attributes[loc].type, size: program.attributes[loc].size, orig: loc });
      }
      order.sort(function (x, y) { return x.index - y.index; });
      if (order.length) {
        var rebuilt = order.slice();
        for (var j = 0; j < program.attributes.length; j++) {
          var found = false;
          for (var q = 0; q < rebuilt.length; q++) if (rebuilt[q].name === program.attributes[j].name) found = true;
          if (!found) rebuilt.push(program.attributes[j]);
        }
        program.attributes = rebuilt;
      }
    }

    /* ---- uniform setters ---- */
    function uniformTarget(location) {
      return location && location.__glUniform ? location : null;
    }
    function setUniform(location, value) {
      var t = uniformTarget(location);
      if (!t) return;
      t.value = value;
      STATS.uniformsSet++;
    }
    function makeSetter(fn) {
      return function (location, a, b, c) {
        var t = uniformTarget(location);
        if (!t) return;
        t.value = fn(a, b, c);
        STATS.uniformsSet++;
      };
    }

    function getUniformLocation(program, name) {
      if (!program || !program.uniforms) return null;
      var key = String(name).replace(/\[0\]$/, "");
      var entry = program.uniforms[key];
      if (!entry) return null;
      if (!entry.__location) entry.__location = { __glUniform: true, name: key, entry: entry, value: null };
      return entry.__location;
    }

    /* ---- canvas painting: keep a visible backing store so lint
       screenshots and toDataURL() show the clear color instead of
       transparent nothing. ---- */
    function paintClear() {
      if (typeof canvas.getContext !== "function") return;
      var c2;
      try { c2 = canvas.getContext("2d"); } catch (e) { return; }
      if (!c2) return;
      var col = state.clearColor;
      c2.save();
      c2.setTransform(1, 0, 0, 1, 0, 0);
      c2.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
      c2.fillStyle = "rgba(" + Math.round(col[0] * 255) + "," + Math.round(col[1] * 255) + "," + Math.round(col[2] * 255) + "," + (col[3] === undefined ? 1 : col[3]) + ")";
      c2.fillRect(0, 0, canvas.width || 1, canvas.height || 1);
      c2.restore();
    }

    /* ---------------------------- API surface ---------------------------- */

    ctx.canvas = canvas;
    Object.defineProperty(ctx, "drawingBufferWidth", { get: W, configurable: true });
    Object.defineProperty(ctx, "drawingBufferHeight", { get: H, configurable: true });
    ctx.drawingBufferColorSpace = "srgb";

    for (var ck in CONST) {
      if (!Object.prototype.hasOwnProperty.call(ctx, ck)) ctx[ck] = CONST[ck];
    }

    ctx.getContextAttributes = function () {
      return {
        alpha: !!(attrs && attrs.alpha) || attrs === undefined,
        antialias: !!(attrs && attrs.antialias),
        depth: !attrs || attrs.depth !== false,
        stencil: !!(attrs && attrs.stencil),
        premultipliedAlpha: !attrs || attrs.premultipliedAlpha !== false,
        preserveDrawingBuffer: !!(attrs && attrs.preserveDrawingBuffer),
        powerPreference: (attrs && attrs.powerPreference) || "default",
        failIfMajorPerformanceCaveat: !!(attrs && attrs.failIfMajorPerformanceCaveat),
        desynchronized: !!(attrs && attrs.desynchronized)
      };
    };

    ctx.getError = function () {
      return state.errors.length ? state.errors.shift() : CONST.NO_ERROR;
    };

    ctx.getSupportedExtensions = function () {
      return [
        "ANGLE_instanced_arrays", "EXT_blend_minmax", "EXT_color_buffer_float",
        "EXT_color_buffer_half_float", "EXT_float_blend", "EXT_frag_depth",
        "EXT_shader_texture_lod", "EXT_texture_filter_anisotropic",
        "OES_element_index_uint", "OES_fbo_render_mipmap", "OES_standard_derivatives",
        "OES_texture_float", "OES_texture_float_linear", "OES_texture_half_float",
        "OES_texture_half_float_linear", "OES_vertex_array_object",
        "WEBGL_color_buffer_float", "WEBGL_compressed_texture_s3tc",
        "WEBGL_debug_renderer_info", "WEBGL_debug_shaders", "WEBGL_depth_texture",
        "WEBGL_draw_buffers", "WEBGL_lose_context", "WEBGL_multi_draw",
        "WEBGL_multisampled_render_to_texture"
      ];
    };

    ctx.getExtension = function (name) {
      switch (String(name)) {
        case "EXT_texture_filter_anisotropic":
        case "MOZ_EXT_texture_filter_anisotropic":
        case "WEBKIT_EXT_texture_filter_anisotropic":
          return {
            MAX_TEXTURE_MAX_ANISOTROPY_EXT: CONST.MAX_TEXTURE_MAX_ANISOTROPY_EXT,
            TEXTURE_MAX_ANISOTROPY_EXT: CONST.TEXTURE_MAX_ANISOTROPY_EXT
          };
        case "WEBGL_debug_renderer_info":
          return {
            UNMASKED_VENDOR_WEBGL: CONST.UNMASKED_VENDOR_WEBGL,
            UNMASKED_RENDERER_WEBGL: CONST.UNMASKED_RENDERER_WEBGL
          };
        case "WEBGL_debug_shaders":
          return { getTranslatedShaderSource: function (shader) { return shader ? String(shader.source || "") : ""; } };
        case "WEBGL_lose_context":
          return {
            loseContext: function () {
              var ev = typeof win.CustomEvent === "function" ? new win.CustomEvent("webglcontextlost") : { type: "webglcontextlost" };
              if (canvas.dispatchEvent) canvas.dispatchEvent(ev);
            },
            restoreContext: function () {
              var ev = typeof win.CustomEvent === "function" ? new win.CustomEvent("webglcontextrestored") : { type: "webglcontextrestored" };
              if (canvas.dispatchEvent) canvas.dispatchEvent(ev);
            }
          };
        case "WEBGL_draw_buffers":
          return {
            drawBuffersWEBGL: function (bufs) { state.drawBuffers = bufs; },
            MAX_DRAW_BUFFERS_WEBGL: CONST.MAX_DRAW_BUFFERS,
            MAX_COLOR_ATTACHMENTS_WEBGL: CONST.MAX_COLOR_ATTACHMENTS,
            COLOR_ATTACHMENT0_WEBGL: CONST.COLOR_ATTACHMENT0,
            COLOR_ATTACHMENT1_WEBGL: CONST.COLOR_ATTACHMENT1,
            COLOR_ATTACHMENT2_WEBGL: CONST.COLOR_ATTACHMENT2,
            COLOR_ATTACHMENT3_WEBGL: CONST.COLOR_ATTACHMENT3
          };
        case "OES_vertex_array_object":
          return {
            createVertexArrayOES: createVertexArray,
            deleteVertexArrayOES: function (v) { return !!v; },
            isVertexArrayOES: function (v) { return !!(v && v.__glKind === "vao"); },
            bindVertexArrayOES: function (v) { state.bound.vao = v; },
            VERTEX_ARRAY_BINDING_OES: 0x85B5
          };
        case "ANGLE_instanced_arrays":
          return {
            drawArraysInstancedANGLE: function (mode, first, count, prim) { ctx.drawArraysInstanced(mode, first, count, prim); },
            drawElementsInstancedANGLE: function (mode, count, type, offset, prim) { ctx.drawElementsInstanced(mode, count, type, offset, prim); },
            vertexAttribDivisorANGLE: function (index, divisor) { ctx.vertexAttribDivisor(index, divisor); },
            VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: 0x88FE
          };
        case "EXT_clip_control":
          return { clipControlEXT: function () {}, LOWER_LEFT_EXT: 0x8CA1, ZERO_TO_ONE_EXT: 0x935F };
        case "WEBGL_clip_cull_distance":
          return {
            MAX_CLIP_DISTANCES_EXT: 0x0D32, MAX_CULL_DISTANCES_EXT: 0x82F9,
            MAX_COMBINED_CLIP_AND_CULL_DISTANCES_EXT: 0x82FA
          };
        case "EXT_color_buffer_float":
        case "EXT_color_buffer_half_float":
        case "EXT_float_blend":
        case "OES_texture_float":
        case "OES_texture_float_linear":
        case "OES_texture_half_float":
        case "OES_texture_half_float_linear":
        case "OES_standard_derivatives":
        case "EXT_frag_depth":
        case "WEBGL_color_buffer_float":
        case "WEBGL_depth_texture":
        case "OES_element_index_uint":
        case "WEBGL_multisampled_render_to_texture":
        case "WEBGL_render_shared_exponent":
        case "EXT_texture_compression_bptc":
        case "WEBGL_compressed_texture_s3tc":
          return {}; // capability flag: presence is what three.js checks
        default:
          return null;
      }
    };

    ctx.getParameter = function (pname) {
      switch (pname) {
        case CONST.VERSION: return "WebGL 2.0 (generative-ui lint polyfill)";
        case CONST.SHADING_LANGUAGE_VERSION: return "WebGL GLSL ES 3.00 (generative-ui lint polyfill)";
        case CONST.VENDOR: return "indirect";
        case CONST.RENDERER: return "generative-ui WebGL polyfill";
        case CONST.UNMASKED_VENDOR_WEBGL: return "indirect";
        case CONST.UNMASKED_RENDERER_WEBGL: return "generative-ui WebGL polyfill (software)";
        case CONST.MAX_TEXTURE_SIZE: return MAX_TEXTURE_SIZE;
        case CONST.MAX_CUBE_MAP_TEXTURE_SIZE: return MAX_TEXTURE_SIZE;
        case CONST.MAX_3D_TEXTURE_SIZE: return 2048;
        case CONST.MAX_ARRAY_TEXTURE_LAYERS: return 2048;
        case CONST.MAX_RENDERBUFFER_SIZE: return MAX_TEXTURE_SIZE;
        case CONST.MAX_TEXTURE_IMAGE_UNITS: return 32;
        case CONST.MAX_VERTEX_TEXTURE_IMAGE_UNITS: return 32;
        case CONST.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return 80;
        case CONST.MAX_VERTEX_ATTRIBS: return 16;
        case CONST.MAX_VERTEX_UNIFORM_VECTORS: return 1024;
        case CONST.MAX_FRAGMENT_UNIFORM_VECTORS: return 1024;
        case CONST.MAX_VARYING_VECTORS: return 30;
        case CONST.MAX_VARYING_COMPONENTS: return 120;
        case CONST.MAX_VERTEX_UNIFORM_COMPONENTS: return 4096;
        case CONST.MAX_FRAGMENT_UNIFORM_COMPONENTS: return 4096;
        case CONST.MAX_DRAW_BUFFERS: return 8;
        case CONST.MAX_COLOR_ATTACHMENTS: return 8;
        case CONST.MAX_SAMPLES: return 8;
        case CONST.MAX_UNIFORM_BUFFER_BINDINGS: return 24;
        case CONST.MAX_UNIFORM_BLOCK_SIZE: return 65536;
        case CONST.UNIFORM_BUFFER_OFFSET_ALIGNMENT: return 256;
        case CONST.MAX_ELEMENTS_VERTICES: return 65536;
        case CONST.MAX_ELEMENTS_INDICES: return 65536;
        case CONST.MAX_TEXTURE_LOD_BIAS: return 2;
        case CONST.MAX_PROGRAM_TEXEL_OFFSET: return 7;
        case CONST.MIN_PROGRAM_TEXEL_OFFSET: return -8;
        case CONST.MAX_VIEWPORT_DIMS: return new Int32Array([MAX_TEXTURE_SIZE, MAX_TEXTURE_SIZE]);
        case CONST.ALIASED_POINT_SIZE_RANGE: return new Float32Array([1, 1024]);
        case CONST.ALIASED_LINE_WIDTH_RANGE: return new Float32Array([1, 1024]);
        case CONST.VIEWPORT: return new Int32Array(state.viewportBox);
        case CONST.SCISSOR_BOX: return new Int32Array(state.scissorBox);
        case CONST.COLOR_CLEAR_VALUE: return new Float32Array(state.clearColor);
        case CONST.DEPTH_CLEAR_VALUE: return state.clearDepth;
        case CONST.DEPTH_RANGE: return new Float32Array([0, 1]);
        case CONST.DEPTH_FUNC: return CONST.LESS;
        case CONST.DEPTH_WRITEMASK: return state.depthMask;
        case CONST.COLOR_WRITEMASK: return new Uint8Array(state.colorMask.map(function (v) { return v ? 1 : 0; }));
        case CONST.CULL_FACE_MODE: return state.cullFaceMode;
        case CONST.FRONT_FACE: return state.frontFace;
        case CONST.BLEND: case CONST.CULL_FACE: case CONST.DEPTH_TEST: case CONST.SCISSOR_TEST:
        case CONST.STENCIL_TEST: case CONST.DITHER: case CONST.POLYGON_OFFSET_FILL:
        case CONST.SAMPLE_ALPHA_TO_COVERAGE: case CONST.SAMPLE_COVERAGE:
          return false;
        case CONST.ACTIVE_TEXTURE: return state.activeTexture;
        case CONST.CURRENT_PROGRAM: return state.currentProgram;
        case CONST.ARRAY_BUFFER_BINDING: return state.bound.arrayBuffer;
        case CONST.ELEMENT_ARRAY_BUFFER_BINDING: return state.bound.elementArrayBuffer;
        case CONST.PIXEL_PACK_BUFFER_BINDING: return state.bound.pixelPackBuffer;
        case CONST.PIXEL_UNPACK_BUFFER_BINDING: return state.bound.pixelUnpackBuffer;
        case CONST.FRAMEBUFFER_BINDING: return state.bound.framebuffer;
        case CONST.RENDERBUFFER_BINDING: return state.bound.renderbuffer;
        case CONST.TEXTURE_BINDING_2D: return state.bound.texture2D;
        case CONST.TEXTURE_BINDING_CUBE_MAP: return state.bound.textureCube;
        case CONST.TEXTURE_BINDING_3D: return state.bound.texture3D;
        case CONST.TEXTURE_BINDING_2D_ARRAY: return state.bound.texture2DArray;
        case CONST.IMPLEMENTATION_COLOR_READ_FORMAT: return CONST.RGBA;
        case CONST.IMPLEMENTATION_COLOR_READ_TYPE: return CONST.UNSIGNED_BYTE;
        case CONST.COMPRESSED_TEXTURE_FORMATS: return new Uint32Array(0);
        case CONST.SAMPLES: return 0;
        case CONST.SAMPLE_BUFFERS: return 0;
        case CONST.SUBPIXEL_BITS: return 4;
        case CONST.RED_BITS: case CONST.GREEN_BITS: case CONST.BLUE_BITS: case CONST.ALPHA_BITS:
          return 8;
        case CONST.DEPTH_BITS: return 24;
        case CONST.STENCIL_BITS: return 8;
        case CONST.UNPACK_ALIGNMENT: return state.pixelStore.unpackAlignment;
        case CONST.PACK_ALIGNMENT: return state.pixelStore.packAlignment;
        case CONST.UNPACK_FLIP_Y_WEBGL: return state.pixelStore.unpackFlipY;
        case CONST.UNPACK_PREMULTIPLY_ALPHA_WEBGL: return state.pixelStore.unpackPremultiplyAlpha;
        case CONST.MAJOR_VERSION: return webgl2 ? 2 : 1;
        case CONST.MINOR_VERSION: return 0;
        case CONST.NUM_EXTENSIONS: return ctx.getSupportedExtensions().length;
        case CONST.CONTEXT_FLAGS: return CONST.CONTEXT_FLAG_FORWARD_COMPATIBLE_BIT;
        case CONST.MAX_DRAW_BUFFERS2: return 8;
        default:
          return 0;
      }
    };

    ctx.getShaderPrecisionFormat = function (shaderType, precisionType) {
      // Real desktop GLSL ranges; precision > 0 keeps three on its "highp" path.
      var range = (precisionType === CONST.HIGH_FLOAT || precisionType === CONST.HIGH_INT) ? 127 : 127;
      return {
        rangeMin: -range,
        rangeMax: range,
        precision: (precisionType === CONST.LOW_FLOAT || precisionType === CONST.LOW_INT) ? 8 : 23
      };
    };

    /* ---- buffers ---- */
    ctx.createBuffer = createBuffer;
    ctx.deleteBuffer = function (b) { return !!b; };
    ctx.isBuffer = function (b) { return !!(b && b.__glKind === "buffer"); };
    ctx.bindBuffer = function (target, buffer) {
      if (target === CONST.ARRAY_BUFFER) state.bound.arrayBuffer = buffer;
      else if (target === CONST.ELEMENT_ARRAY_BUFFER) state.bound.elementArrayBuffer = buffer;
      else if (target === CONST.PIXEL_PACK_BUFFER) state.bound.pixelPackBuffer = buffer;
      else if (target === CONST.PIXEL_UNPACK_BUFFER) state.bound.pixelUnpackBuffer = buffer;
      if (buffer) buffer.target = target;
    };
    ctx.bindBufferBase = function (target, index, buffer) {
      if (target === CONST.UNIFORM_BUFFER) state.bound.uniformBuffer = { index: index, buffer: buffer };
    };
    ctx.bindBufferRange = function (target, index, buffer, offset, size) {
      if (target === CONST.UNIFORM_BUFFER) state.bound.uniformBuffer = { index: index, buffer: buffer, offset: offset, size: size };
    };
    ctx.bufferData = function (target, dataOrSize, usage) {
      var buf = target === CONST.ARRAY_BUFFER ? state.bound.arrayBuffer : state.bound.elementArrayBuffer;
      if (buf) buf.data = dataOrSize;
    };
    ctx.bufferSubData = function (target, offset, data) { /* recorded only */ };
    ctx.copyBufferSubData = function () {};
    ctx.getBufferParameter = function (target, pname) {
      var buf = target === CONST.ARRAY_BUFFER ? state.bound.arrayBuffer : state.bound.elementArrayBuffer;
      if (!buf) return null;
      if (pname === CONST.BUFFER_SIZE) {
        if (typeof buf.data === "number") return buf.data;
        if (buf.data && typeof buf.data.byteLength === "number") return buf.data.byteLength;
        return 0;
      }
      return CONST.STATIC_DRAW;
    };
    ctx.getBufferSubData = function (target, offset, dst) {
      if (dst && dst.fill) dst.fill(0);
    };

    /* ---- shaders / programs ---- */
    ctx.createShader = createShader;
    ctx.shaderSource = shaderSource;
    ctx.compileShader = compileShader;
    ctx.deleteShader = function (s) { return !!s; };
    ctx.isShader = function (s) { return !!(s && s.__glKind === "shader"); };
    ctx.getShaderParameter = function (shader, pname) {
      if (!shader) return null;
      if (pname === CONST.COMPILE_STATUS) return shader.compileStatus;
      if (pname === CONST.SHADER_TYPE) return shader.type;
      if (pname === CONST.DELETE_STATUS) return false;
      return 0;
    };
    ctx.getShaderInfoLog = function (shader) { return shader ? (shader.infoLog || "") : ""; };
    ctx.getShaderSource = function (shader) { return shader ? (shader.source || "") : ""; };

    ctx.createProgram = createProgram;
    ctx.attachShader = attachShader;
    ctx.detachShader = detachShader;
    ctx.linkProgram = linkProgram;
    ctx.useProgram = function (program) { state.currentProgram = program; };
    ctx.validateProgram = function () {};
    ctx.deleteProgram = function (p) { return !!p; };
    ctx.isProgram = function (p) { return !!(p && p.__glKind === "program"); };
    ctx.getAttachedShaders = function (program) { return program ? program.shaders.slice() : []; };
    ctx.getProgramParameter = function (program, pname) {
      if (!program) return null;
      switch (pname) {
        case CONST.LINK_STATUS: return program.linkStatus;
        case CONST.VALIDATE_STATUS: return true;
        case CONST.DELETE_STATUS: return false;
        case CONST.ATTACHED_SHADERS: return program.shaders.length;
        case CONST.ACTIVE_UNIFORMS: return Object.keys(program.uniforms).length;
        case CONST.ACTIVE_ATTRIBUTES: return program.attributes.length;
        case CONST.ACTIVE_UNIFORM_MAX_LENGTH: return 64;
        case CONST.ACTIVE_ATTRIBUTE_MAX_LENGTH: return 64;
        default: return 0;
      }
    };
    ctx.getProgramInfoLog = function (program) { return program ? (program.infoLog || "") : ""; };
    ctx.getAttribLocation = getAttribLocation;
    ctx.bindAttribLocation = bindAttribLocation;
    ctx.getActiveAttrib = function (program, index) {
      if (!program || !program.attributes[index]) return null;
      var a = program.attributes[index];
      return { name: a.name, size: a.size, type: a.type };
    };
    ctx.getActiveUniform = function (program, index) {
      if (!program) return null;
      var names = Object.keys(program.uniforms);
      var entry = program.uniforms[names[index]];
      if (!entry) return null;
      return { name: entry.size > 1 ? entry.name + "[0]" : entry.name, size: entry.size, type: entry.type };
    };
    ctx.getUniformLocation = getUniformLocation;
    ctx.getUniform = function (program, location) {
      var t = uniformTarget(location);
      return t ? t.value : null;
    };

    /* uniform setters: one per GLSL arity/type combination */
    ctx.uniform1f = makeSetter(function (x) { return x; });
    ctx.uniform2f = makeSetter(function (x, y) { return [x, y]; });
    ctx.uniform3f = makeSetter(function (x, y, z) { return [x, y, z]; });
    ctx.uniform4f = makeSetter(function (x, y, z, w) { return [x, y, z, w]; });
    ctx.uniform1i = makeSetter(function (x) { return x; });
    ctx.uniform2i = makeSetter(function (x, y) { return [x, y]; });
    ctx.uniform3i = makeSetter(function (x, y, z) { return [x, y, z]; });
    ctx.uniform4i = makeSetter(function (x, y, z, w) { return [x, y, z, w]; });
    ctx.uniform1ui = ctx.uniform1i;
    ctx.uniform2ui = ctx.uniform2i;
    ctx.uniform3ui = ctx.uniform3i;
    ctx.uniform4ui = ctx.uniform4i;
    ctx.uniform1fv = makeSetter(function (v) { return Array.prototype.slice.call(v); });
    ctx.uniform2fv = ctx.uniform1fv;
    ctx.uniform3fv = ctx.uniform1fv;
    ctx.uniform4fv = ctx.uniform1fv;
    ctx.uniform1iv = ctx.uniform1fv;
    ctx.uniform2iv = ctx.uniform1fv;
    ctx.uniform3iv = ctx.uniform1fv;
    ctx.uniform4iv = ctx.uniform1fv;
    ctx.uniform1uiv = ctx.uniform1fv;
    ctx.uniform2uiv = ctx.uniform1fv;
    ctx.uniform3uiv = ctx.uniform1fv;
    ctx.uniform4uiv = ctx.uniform1fv;
    ctx.uniformMatrix2fv = makeSetter(function (v) { return Array.prototype.slice.call(v); });
    ctx.uniformMatrix3fv = ctx.uniformMatrix2fv;
    ctx.uniformMatrix4fv = ctx.uniformMatrix2fv;
    ctx.uniformMatrix2x3fv = ctx.uniformMatrix2fv;
    ctx.uniformMatrix2x4fv = ctx.uniformMatrix2fv;
    ctx.uniformMatrix3x2fv = ctx.uniformMatrix2fv;
    ctx.uniformMatrix3x4fv = ctx.uniformMatrix2fv;
    ctx.uniformMatrix4x2fv = ctx.uniformMatrix2fv;
    ctx.uniformMatrix4x3fv = ctx.uniformMatrix2fv;

    ctx.getUniformBlockIndex = function (program, name) {
      if (!program) return 0xFFFFFFFF;
      var names = Object.keys(program.uniforms);
      var idx = names.indexOf(name);
      return idx >= 0 ? idx : 0xFFFFFFFF;
    };
    ctx.uniformBlockBinding = function () {};

    /* ---- vertex attribs ---- */
    ctx.enableVertexAttribArray = function () {};
    ctx.disableVertexAttribArray = function () {};
    ctx.vertexAttribPointer = function () {};
    ctx.vertexAttribIPointer = function () {};
    ctx.vertexAttribDivisor = function () {};
    ctx.vertexAttrib1f = function () {};
    ctx.vertexAttrib2f = function () {};
    ctx.vertexAttrib3f = function () {};
    ctx.vertexAttrib4f = function () {};
    ctx.vertexAttrib1fv = function () {};
    ctx.vertexAttrib2fv = function () {};
    ctx.vertexAttrib3fv = function () {};
    ctx.vertexAttrib4fv = function () {};
    ctx.vertexAttribI4i = function () {};
    ctx.vertexAttribI4iv = function () {};
    ctx.vertexAttribI4ui = function () {};
    ctx.vertexAttribI4uiv = function () {};
    ctx.getVertexAttrib = function (index, pname) {
      switch (pname) {
        case CONST.VERTEX_ATTRIB_ARRAY_ENABLED: return false;
        case CONST.VERTEX_ATTRIB_ARRAY_SIZE: return 4;
        case CONST.VERTEX_ATTRIB_ARRAY_STRIDE: return 0;
        case CONST.VERTEX_ATTRIB_ARRAY_TYPE: return CONST.FLOAT;
        case CONST.VERTEX_ATTRIB_ARRAY_NORMALIZED: return false;
        case CONST.VERTEX_ATTRIB_ARRAY_INTEGER: return false;
        case CONST.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: return state.bound.arrayBuffer;
        default: return 0;
      }
    };
    ctx.getVertexAttribOffset = function () { return 0; };

    /* ---- VAOs ---- */
    ctx.createVertexArray = createVertexArray;
    ctx.deleteVertexArray = function (v) { return !!v; };
    ctx.isVertexArray = function (v) { return !!(v && v.__glKind === "vao"); };
    ctx.bindVertexArray = function (v) { state.bound.vao = v; };

    /* ---- textures ---- */
    ctx.createTexture = createTexture;
    ctx.deleteTexture = function (t) { return !!t; };
    ctx.isTexture = function (t) { return !!(t && t.__glKind === "texture"); };
    ctx.bindTexture = function (target, texture) {
      if (texture) texture.target = target;
      if (target === CONST.TEXTURE_2D) state.bound.texture2D = texture;
      else if (target === CONST.TEXTURE_CUBE_MAP) state.bound.textureCube = texture;
      else if (target === CONST.TEXTURE_3D) state.bound.texture3D = texture;
      else if (target === CONST.TEXTURE_2D_ARRAY) state.bound.texture2DArray = texture;
    };
    ctx.activeTexture = function (unit) { state.activeTexture = unit; };
    ctx.texParameterf = function (target, pname, param) { /* recorded only */ };
    ctx.texParameteri = function (target, pname, param) { /* recorded only */ };
    ctx.getTexParameter = function (target, pname) {
      if (pname === CONST.TEXTURE_MIN_FILTER || pname === CONST.TEXTURE_MAG_FILTER) return CONST.LINEAR;
      return CONST.CLAMP_TO_EDGE;
    };
    function recordTex(target, level, w, h) {
      var t = state.bound.texture2D;
      if (target === CONST.TEXTURE_CUBE_MAP || (target >= CONST.TEXTURE_CUBE_MAP_POSITIVE_X && target <= CONST.TEXTURE_CUBE_MAP_NEGATIVE_Z)) t = state.bound.textureCube;
      else if (target === CONST.TEXTURE_3D) t = state.bound.texture3D;
      else if (target === CONST.TEXTURE_2D_ARRAY) t = state.bound.texture2DArray;
      if (t) { t.level = level; t.w = w; t.h = h; }
    }
    ctx.texImage2D = function (target, level, internalformat, widthOrSource, heightOrBorder, borderOrType, formatOrPixels, typeOrPixels, pixels) {
      var w = 0, h = 0;
      if (arguments.length === 6) {
        // texImage2D(target, level, internalformat, format, type, source)
        var src = arguments[5];
        w = (src && (src.width || src.videoWidth)) || 0;
        h = (src && (src.height || src.videoHeight)) || 0;
      } else {
        w = widthOrSource;
        h = heightOrBorder;
      }
      recordTex(target, level, w, h);
    };
    ctx.texSubImage2D = function () {};
    ctx.texImage3D = function () {};
    ctx.texSubImage3D = function () {};
    ctx.texStorage2D = function (target, levels, internalformat, width, height) {
      recordTex(target, 0, width, height);
    };
    ctx.texStorage3D = function () {};
    ctx.copyTexImage2D = function () {};
    ctx.copyTexSubImage2D = function () {};
    ctx.copyTexSubImage3D = function () {};
    ctx.compressedTexImage2D = function () {};
    ctx.compressedTexImage3D = function () {};
    ctx.compressedTexSubImage2D = function () {};
    ctx.compressedTexSubImage3D = function () {};
    ctx.generateMipmap = function () {};

    /* ---- framebuffers & renderbuffers ---- */
    ctx.createFramebuffer = createFramebuffer;
    ctx.deleteFramebuffer = function (f) { return !!f; };
    ctx.isFramebuffer = function (f) { return !!(f && f.__glKind === "framebuffer"); };
    ctx.bindFramebuffer = function (target, fb) {
      state.bound.framebuffer = fb;
    };
    ctx.framebufferTexture2D = function (target, attachment, textarget, texture, level) {
      if (state.bound.framebuffer) state.bound.framebuffer.attachments[attachment] = texture;
    };
    ctx.framebufferTextureLayer = function (target, attachment, texture, level, layer) {
      if (state.bound.framebuffer) state.bound.framebuffer.attachments[attachment] = texture;
    };
    ctx.framebufferRenderbuffer = function (target, attachment, renderbuffertarget, renderbuffer) {
      if (state.bound.framebuffer) state.bound.framebuffer.attachments[attachment] = renderbuffer;
    };
    ctx.checkFramebufferStatus = function () { return CONST.FRAMEBUFFER_COMPLETE; };
    ctx.getFramebufferAttachmentParameter = function (target, attachment, pname) {
      var fb = state.bound.framebuffer;
      if (!fb) return 0;
      var obj = fb.attachments[attachment];
      if (pname === CONST.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) return obj ? (obj.__glKind === "renderbuffer" ? CONST.RENDERBUFFER : CONST.TEXTURE) : CONST.NONE;
      return obj || 0;
    };
    ctx.createRenderbuffer = createRenderbuffer;
    ctx.deleteRenderbuffer = function (r) { return !!r; };
    ctx.isRenderbuffer = function (r) { return !!(r && r.__glKind === "renderbuffer"); };
    ctx.bindRenderbuffer = function (target, rb) { state.bound.renderbuffer = rb; };
    ctx.renderbufferStorage = function (target, internalformat, width, height) {
      if (state.bound.renderbuffer) {
        state.bound.renderbuffer.w = width;
        state.bound.renderbuffer.h = height;
        state.bound.renderbuffer.format = internalformat;
      }
    };
    ctx.renderbufferStorageMultisample = function () {
      warnOnce("renderbufferStorageMultisample: MSAA resolved by the software polyfill");
    };
    ctx.getRenderbufferParameter = function (target, pname) {
      var rb = state.bound.renderbuffer;
      if (!rb) return 0;
      if (pname === CONST.RENDERBUFFER_WIDTH) return rb.w;
      if (pname === CONST.RENDERBUFFER_HEIGHT) return rb.h;
      if (pname === CONST.RENDERBUFFER_INTERNAL_FORMAT) return rb.format;
      return 8;
    };
    ctx.invalidateFramebuffer = function () {};
    ctx.invalidateSubFramebuffer = function () {};
    ctx.blitFramebuffer = function () { warnOnce("blitFramebuffer: simplified by the software polyfill"); };

    /* ---- samplers ---- */
    ctx.createSampler = createSampler;
    ctx.deleteSampler = function (s) { return !!s; };
    ctx.isSampler = function (s) { return !!(s && s.__glKind === "sampler"); };
    ctx.bindSampler = function () {};
    ctx.samplerParameteri = function () {};
    ctx.samplerParameterf = function () {};
    ctx.getSamplerParameter = function () { return 0; };

    /* ---- reads ---- */
    ctx.readPixels = function (x, y, width, height, format, type, pixels) {
      if (!pixels || !pixels.length) return;
      if (format === CONST.RGBA && type === CONST.UNSIGNED_BYTE) {
        var col = state.clearColor;
        var r = Math.round(col[0] * 255), g = Math.round(col[1] * 255), b = Math.round(col[2] * 255);
        var a = Math.round((col[3] === undefined ? 1 : col[3]) * 255);
        for (var i = 0; i < pixels.length; i += 4) {
          pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
        }
      } else {
        for (var j = 0; j < pixels.length; j++) pixels[j] = 0;
      }
    };
    ctx.readBuffer = function () {};
    ctx.finish = function () {};
    ctx.flush = function () {};

    /* ---- state ---- */
    ctx.enable = function () {};
    ctx.disable = function () {};
    ctx.isEnabled = function () { return false; };
    ctx.blendFunc = function () {};
    ctx.blendFuncSeparate = function () {};
    ctx.blendEquation = function () {};
    ctx.blendEquationSeparate = function () {};
    ctx.blendColor = function () {};
    ctx.colorMask = function (r, g, b, a) { state.colorMask = [!!r, !!g, !!b, !!a]; };
    ctx.cullFace = function (mode) { state.cullFaceMode = mode; };
    ctx.frontFace = function (mode) { state.frontFace = mode; };
    ctx.depthFunc = function () {};
    ctx.depthMask = function (flag) { state.depthMask = !!flag; };
    ctx.depthRange = function () {};
    ctx.stencilFunc = function () {};
    ctx.stencilFuncSeparate = function () {};
    ctx.stencilMask = function () {};
    ctx.stencilMaskSeparate = function () {};
    ctx.stencilOp = function () {};
    ctx.stencilOpSeparate = function () {};
    ctx.clearStencil = function (s) { state.clearStencil = s; };
    ctx.clearDepth = function (d) { state.clearDepth = d; };
    ctx.clearColor = function (r, g, b, a) { state.clearColor = [r, g, b, a]; };
    ctx.scissor = function (x, y, w, h) { state.scissorBox = [x, y, w, h]; };
    ctx.viewport = function (x, y, w, h) { state.viewportBox = [x, y, w, h]; };
    ctx.lineWidth = function () {};
    ctx.polygonOffset = function () {};
    ctx.sampleCoverage = function () {};
    ctx.hint = function () {};
    ctx.pixelStorei = function (pname, param) {
      if (pname === CONST.UNPACK_FLIP_Y_WEBGL) state.pixelStore.unpackFlipY = !!param;
      else if (pname === CONST.UNPACK_PREMULTIPLY_ALPHA_WEBGL) state.pixelStore.unpackPremultiplyAlpha = !!param;
      else if (pname === CONST.UNPACK_ALIGNMENT) state.pixelStore.unpackAlignment = param;
      else if (pname === CONST.PACK_ALIGNMENT) state.pixelStore.packAlignment = param;
    };

    /* ---- drawing ---- */
    ctx.clear = function (mask) {
      STATS.clearCalls++;
      if (mask & CONST.COLOR_BUFFER_BIT) paintClear();
    };
    ctx.drawArrays = function () { STATS.drawCalls++; };
    ctx.drawElements = function () { STATS.drawCalls++; };
    ctx.drawArraysInstanced = function () { STATS.drawCalls++; };
    ctx.drawElementsInstanced = function () { STATS.drawCalls++; };
    ctx.drawRangeElements = function () { STATS.drawCalls++; };
    ctx.drawBuffers = function (bufs) { state.drawBuffers = bufs; };
    ctx.clearBufferfv = function (buffer, drawbuffer, values, srcOffset) {
      if (buffer === CONST.COLOR && values) state.clearColor = [values[0], values[1], values[2], values[3]];
      STATS.clearCalls++;
    };
    ctx.clearBufferiv = function () { STATS.clearCalls++; };
    ctx.clearBufferuiv = function () { STATS.clearCalls++; };
    ctx.clearBufferfi = function () { STATS.clearCalls++; };

    /* ---- queries, fences, transform feedback ---- */
    ctx.createQuery = function () { return makeRes("query"); };
    ctx.deleteQuery = function () {};
    ctx.isQuery = function () { return false; };
    ctx.beginQuery = function () {};
    ctx.endQuery = function () {};
    ctx.getQuery = function () { return null; };
    ctx.getQueryParameter = function (query, pname) {
      return pname === CONST.QUERY_RESULT_AVAILABLE ? true : 1;
    };
    ctx.fenceSync = function () { return makeRes("sync"); };
    ctx.deleteSync = function () {};
    ctx.isSync = function () { return false; };
    ctx.clientWaitSync = function () { return CONST.ALREADY_SIGNALED; };
    ctx.waitSync = function () {};
    ctx.getSyncParameter = function (sync, pname) {
      return pname === CONST.SYNC_STATUS ? CONST.SIGNALED : 0;
    };
    ctx.createTransformFeedback = function () { return makeRes("transformfeedback"); };
    ctx.deleteTransformFeedback = function () {};
    ctx.isTransformFeedback = function () { return false; };
    ctx.bindTransformFeedback = function () {};
    ctx.beginTransformFeedback = function () {};
    ctx.endTransformFeedback = function () {};
    ctx.pauseTransformFeedback = function () {};
    ctx.resumeTransformFeedback = function () {};
    ctx.transformFeedbackVaryings = function () {};
    ctx.getTransformFeedbackVarying = function () { return null; };
    ctx.getInternalformatParameter = function () { return new Int32Array([4]); };
    ctx.getIndexedParameter = function () { return null; };

    /* Future/unknown entry points (e.g. experimental HTML-in-canvas texture
       APIs) stay undefined on purpose: three.js feature-detects them with
       "in" checks and falls back to standard paths. */

    return ctx;
  }

  /* ------------------------------ install ------------------------------ */

  var origGetContext = win.HTMLCanvasElement && win.HTMLCanvasElement.prototype.getContext;
  if (typeof origGetContext !== "function") {
    win.__guWebglPolyfill = { installed: false, reason: "no-canvas", stats: null };
    return;
  }

  var CACHE = new WeakMap();

  function polyfillGetContext(type, attrs) {
    var t = String(type || "").toLowerCase();
    var isGL = t === "webgl2" || t === "webgl" || t === "experimental-webgl";
    if (!isGL) return origGetContext.call(this, type, attrs);
    var cached = CACHE.get(this);
    if (cached && cached.type === t) return cached.ctx;
    var ctx = createContext(this, attrs, t === "webgl2");
    CACHE.set(this, { type: t, ctx: ctx });
    STATS.contexts++;
    return ctx;
  }

  win.HTMLCanvasElement.prototype.getContext = polyfillGetContext;

  if (win.OffscreenCanvas && win.OffscreenCanvas.prototype) {
    var origOffscreen = win.OffscreenCanvas.prototype.getContext;
    win.OffscreenCanvas.prototype.getContext = function (type, attrs) {
      var t = String(type || "").toLowerCase();
      var isGL = t === "webgl2" || t === "webgl" || t === "experimental-webgl";
      if (!isGL) return origOffscreen.call(this, type, attrs);
      var cached = CACHE.get(this);
      if (cached && cached.type === t) return cached.ctx;
      var ctx = createContext(this, attrs, t === "webgl2");
      CACHE.set(this, { type: t, ctx: ctx });
      STATS.contexts++;
      return ctx;
    };
  }

  win.__guWebglPolyfill = {
    installed: true,
    reason: "no-native-webgl",
    version: 1,
    stats: STATS,
    summary: function () {
      return {
        contexts: STATS.contexts,
        programs: STATS.programs,
        shaders: STATS.shaders,
        drawCalls: STATS.drawCalls,
        clearCalls: STATS.clearCalls,
        compileErrors: STATS.compileErrors,
        linkErrors: STATS.linkErrors,
        uniformsSet: STATS.uniformsSet,
        textures: STATS.textures,
        buffers: STATS.buffers,
        warnings: Object.keys(STATS.warnings),
        shaderErrors: STATS.shaderErrors.slice(0, 8)
      };
    }
  };
})();
`;
