// GPU half of the pipeline (WebGL2): draws every grid cell as a shape at output size, then adds the Halo Glow.
//
//   grid RGBA (one texel per cell) --cells--> A (output size) --bright--> B (half size) --blur x2--> B
//   A + B * intensity --composite--> canvas (preview) or D (export, read back with read())

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const CELLS = `#version 300 es
precision highp float;
uniform sampler2D grid;
uniform vec2 gridSize, outSize;
uniform int shape;
uniform float size;
uniform vec3 bg;
out vec4 o;
void main() {
  vec2 uv = vec2(gl_FragCoord.x, outSize.y - gl_FragCoord.y) / outSize;   // top-left origin, like the grid rows
  vec2 g = uv * gridSize;
  vec2 cell = min(floor(g), gridSize - 1.0);
  vec2 f = fract(g) - 0.5;
  vec3 col = texelFetch(grid, ivec2(cell), 0).rgb;
  float cellPx = outSize.x / gridSize.x;
  float aa = 0.75 / max(cellPx, 0.001);
  float r = size * 0.5;
  float m = 1.0, area = 1.0;
  vec3 c = col;
  if (shape == 0) {            // square
    float d = max(abs(f.x), abs(f.y));
    m = size >= 0.999 ? 1.0 : 1.0 - smoothstep(r - aa, r + aa, d);
    area = size * size;
  } else if (shape == 1 || shape == 2) {   // dot, bead
    float d = length(f);
    m = 1.0 - smoothstep(r - aa, r + aa, d);
    area = min(1.0, 3.14159 * r * r);
    if (shape == 2) {
      float k = clamp(d / max(r, 1e-3), 0.0, 1.0);
      float spec = 1.0 - smoothstep(0.0, r * 0.55, length(f - vec2(-0.16, -0.18) * size));
      c = col * (1.08 - 0.42 * k * k) + vec3(spec * 0.32);
    }
  } else if (shape == 3) {     // horizontal line
    m = 1.0 - smoothstep(r - aa, r + aa, abs(f.y));
    area = size;
  } else if (shape == 4) {     // vertical line
    m = 1.0 - smoothstep(r - aa, r + aa, abs(f.x));
    area = size;
  } else {                     // diamond
    m = 1.0 - smoothstep(r - aa, r + aa, abs(f.x) + abs(f.y));
    area = min(1.0, 2.0 * r * r);
  }
  // cells only a pixel or two wide cannot show a shape: fade to the shape's average coverage (keeps the tone right)
  float tiny = clamp((3.0 - cellPx) / 2.0, 0.0, 1.0);
  vec3 sharp = mix(bg, c, m);
  vec3 avg = mix(bg, col, area);
  o = vec4(mix(sharp, avg, tiny), 1.0);
}`;

const BRIGHT = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 size;
uniform float threshold, smoothing;
out vec4 o;
void main() {
  vec3 c = texture(src, gl_FragCoord.xy / size).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = smoothstep(threshold - smoothing * 0.5, threshold + smoothing * 0.5 + 1e-4, l);
  o = vec4(c * k, 1.0);
}`;

const BLUR = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 size;
uniform vec2 dir;        // full radius in pixels along this pass
uniform float eps, dscale;
const int N = 40;
out vec4 o;
void main() {
  vec2 st = gl_FragCoord.xy / size;
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int i = -N; i <= N; i++) {
    float t = float(i) / float(N);
    float d = t * dscale;
    float w = 1.0 / (eps + d * d);         // epsilon falloff: a bright core with a long soft tail
    acc += texture(src, st + dir * t / size).rgb * w;
    ws += w;
  }
  o = vec4(acc / ws, 1.0);
}`;

const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D base, glow, halo;
uniform vec2 size;
uniform float intensity;
uniform int useGlow;
out vec4 o;
void main() {
  vec3 c = texelFetch(base, ivec2(gl_FragCoord.xy), 0).rgb;
  if (useGlow == 1) {
    vec2 st = gl_FragCoord.xy / size;
    c += (texture(halo, st).rgb * 1.1 + texture(glow, st).rgb * 0.9) * intensity;   // tight halo + wide haze
  }
  o = vec4(min(c, vec3(1.0)), 1.0);
}`;

const SHAPE_IDS = { square: 0, dot: 1, bead: 2, hline: 3, vline: 4, diamond: 5 };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.targets = {};
    this.programs = {
      cells: this.program(CELLS), bright: this.program(BRIGHT), blur: this.program(BLUR), composite: this.program(COMPOSITE),
    };
    this.grid = this.texture(gl.NEAREST);
    this.gridSize = [1, 1];
    this.vao = gl.createVertexArray();
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  }

  program(fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const loc = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      loc[name] = gl.getUniformLocation(p, name);
    }
    return { p, loc };
  }

  texture(filter) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  target(name, w, h) {
    const gl = this.gl;
    let t = this.targets[name];
    if (t && t.w === w && t.h === h) return t;
    if (!t) {
      t = { tex: this.texture(gl.LINEAR), fb: gl.createFramebuffer() };
      this.targets[name] = t;
    }
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    t.w = w; t.h = h;
    return t;
  }

  /** Upload the colourised grid (RGBA bytes, rows top to bottom). */
  setGrid(rgba, gw, gh) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.grid);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gw, gh, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
    this.gridSize = [gw, gh];
  }

  pass(prog, target, w, h, uniforms, textures) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    let unit = 0;
    for (const [name, tex] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(prog.loc[name], unit++);
    }
    for (const [name, v] of Object.entries(uniforms)) {
      const l = prog.loc[name];
      if (l == null) continue;
      if (Array.isArray(v)) (v.length === 2 ? gl.uniform2fv : gl.uniform3fv).call(gl, l, v);
      else if (Number.isInteger(v) && (name === "shape" || name === "useGlow")) gl.uniform1i(l, v);
      else gl.uniform1f(l, v);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Draw the current grid at outW x outH. opts: shape, shapeSize, bg [r,g,b] 0..1, glow (null or settings).
   * toCanvas: true draws into the canvas (resized to fit), false into an offscreen target for read().
   */
  draw(outW, outH, opts, toCanvas = true) {
    const gl = this.gl;
    outW = Math.max(1, Math.min(this.maxSize, Math.round(outW)));
    outH = Math.max(1, Math.min(this.maxSize, Math.round(outH)));
    const A = this.target("A", outW, outH);
    this.pass(this.programs.cells, A, outW, outH, {
      gridSize: this.gridSize, outSize: [outW, outH], shape: SHAPE_IDS[opts.shape] ?? 0,
      size: Math.max(0.05, Math.min(1, opts.shapeSize ?? 1)), bg: opts.bg || [0, 0, 0],
    }, { grid: this.grid });

    const g = opts.glow;
    let B = null, H = null;
    if (g) {
      const bw = Math.max(1, Math.ceil(outW / 2)), bh = Math.max(1, Math.ceil(outH / 2));
      B = this.target("B", bw, bh);
      const C = this.target("C", bw, bh);
      const E = this.target("E", bw, bh);
      H = this.target("H", bw, bh);
      this.pass(this.programs.bright, B, bw, bh, { size: [bw, bh], threshold: g.threshold, smoothing: g.smoothing }, { src: A.tex });
      const comp = g.radiusComp ? Math.sqrt(outW * outH) / 1000 : 1;
      const th = (g.direction * Math.PI) / 180;
      const aspect = Math.max(0.05, g.aspect || 1);
      const common = { size: [bw, bh], eps: Math.max(0.001, g.epsilon), dscale: Math.max(0.05, g.distanceScale) };
      const blur2 = (R, src, tmp, dst) => { // along the Direction, then across it (shortened by the Aspect Ratio)
        this.pass(this.programs.blur, tmp, bw, bh, { ...common, dir: [Math.cos(th) * R, Math.sin(th) * R] }, { src: src.tex });
        this.pass(this.programs.blur, dst, bw, bh, { ...common, dir: [-Math.sin(th) * R / aspect, Math.cos(th) * R / aspect] }, { src: tmp.tex });
      };
      const R = Math.max(0.5, (g.radius * comp) / 2); // half-size pixels
      blur2(Math.max(1, R * 0.18), B, C, H); // halo around each dot
      blur2(R, B, C, E); // wide haze
      B = E;
    }
    let out = null;
    if (toCanvas) {
      if (this.canvas.width !== outW) this.canvas.width = outW;
      if (this.canvas.height !== outH) this.canvas.height = outH;
    } else {
      out = this.target("D", outW, outH);
    }
    this.pass(this.programs.composite, out, outW, outH, {
      size: [outW, outH], intensity: g ? g.intensity : 0, useGlow: g ? 1 : 0,
    }, { base: A.tex, glow: (B || A).tex, halo: (H || A).tex });
    this.last = { w: outW, h: outH, target: out };
    return this.last;
  }

  /** RGBA bytes of the last offscreen draw, rows top to bottom (ready for ffmpeg or a canvas). */
  read(into = null) {
    const gl = this.gl, { w, h, target } = this.last;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = into && into.length === raw.length ? into : new Uint8Array(raw.length);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }
}
