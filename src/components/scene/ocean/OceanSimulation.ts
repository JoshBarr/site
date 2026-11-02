import {
  ComputeNode,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  StorageTexture,
  WebGPURenderer,
} from "three/webgpu";
import {
  Fn,
  cos,
  float,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  select,
  sin,
  textureStore,
  uint,
  uniform,
  vec2,
  vec4,
} from "three/tsl";
import { buildSpectrum, Cascade, OceanConditions } from "./spectrum";

// TSL complex numbers are vec2 (re, im). Typed loosely: the TSL typings
// don't follow swizzles and arithmetic through generic nodes.
type Complex = any;

const cmul = (a: Complex, b: Complex): Complex =>
  vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));

/** Multiply by i. */
const ci = (a: Complex): Complex => vec2(a.y.negate(), a.x);

/**
 * FFT ocean (Tessendorf). Each frame:
 *   1. advance the spectrum to the current time, producing eight real fields
 *      packed two-per-complex into two vec4 buffers,
 *   2. inverse FFT rows then columns (Stockham, radix 2, no bit reversal),
 *   3. write displacement and derivative textures per cascade.
 *
 * displacement: (x, y, z, jacobian)   derivatives: (dy/dx, dy/dz, dx/dx, dz/dz)
 */
export class OceanSimulation {
  readonly size: number;
  readonly cascades: Cascade[];
  readonly displacement: StorageTexture[];
  readonly derivatives: StorageTexture[];
  readonly time = uniform(0);
  /** Horizontal displacement scale; higher is sharper crests. */
  readonly choppiness = uniform(1);

  private h0: any;
  private waves: any;
  private passes: ComputeNode[] = [];

  constructor(size: number, cascades: Cascade[]) {
    this.size = size;
    this.cascades = cascades;

    const texture = () => {
      const t = new StorageTexture(size, size);
      t.type = HalfFloatType;
      t.wrapS = t.wrapT = RepeatWrapping;
      t.magFilter = LinearFilter;
      t.minFilter = LinearMipmapLinearFilter;
      t.generateMipmaps = true;

      return t;
    };

    this.displacement = cascades.map(texture);
    this.derivatives = cascades.map(texture);

    this.build();
  }

  setConditions(conditions: OceanConditions) {
    const { h0, waves } = buildSpectrum(this.size, this.cascades, conditions);

    for (const [node, data] of [
      [this.h0, h0],
      [this.waves, waves],
    ] as const) {
      node.value.array.set(data);
      node.value.needsUpdate = true;
    }
  }

  update(renderer: WebGPURenderer, time: number) {
    this.time.value = time;

    // One compute pass; WebGPU orders its dispatches.
    renderer.compute(this.passes);
  }

  private build() {
    const n = this.size;
    const half = n / 2;
    const count = this.cascades.length * n * n;

    this.h0 = instancedArray(count, "vec4");
    this.waves = instancedArray(count, "vec4");
    const a = [instancedArray(count, "vec4"), instancedArray(count, "vec4")];
    const b = [instancedArray(count, "vec4"), instancedArray(count, "vec4")];

    const spectrum = Fn(() => {
      const h0 = this.h0.element(instanceIndex);
      const wave = this.waves.element(instanceIndex);
      const phase = wave.z.mul(this.time);
      const e = vec2(cos(phase), sin(phase));
      // h0(k)·e^(-iωt) makes each mode e^(i(k·x - ωt)), which travels along
      // +k, i.e. downwind. The conjugate term keeps the surface real.
      const h = cmul(h0.xy, vec2(e.x, e.y.negate())).add(cmul(h0.zw, e));
      const ih = ci(h);

      const kx = wave.x;
      const kz = wave.y;
      const invK = wave.w;

      const dx = ih.mul(kx.mul(invK).negate());
      const dz = ih.mul(kz.mul(invK).negate());
      const dydx = ih.mul(kx);
      const dydz = ih.mul(kz);
      const dxdx = h.mul(kx.mul(kx).mul(invK));
      const dzdz = h.mul(kz.mul(kz).mul(invK));
      const dxdz = h.mul(kx.mul(kz).mul(invK));

      // Real-valued outputs, so pack pairs as X + iY.
      a[0].element(instanceIndex).assign(vec4(dx.add(ci(h)), dz.add(ci(dydx))));
      b[0]
        .element(instanceIndex)
        .assign(vec4(dydz.add(ci(dxdx)), dzdz.add(ci(dxdz))));
    })().compute(count);

    this.passes.push(spectrum);

    // Stockham passes: Ns = 1, 2, ... n/2 along rows, then along columns.
    const stages = Math.log2(n);
    let src = 0;

    for (const horizontal of [true, false]) {
      for (let stage = 0; stage < stages; stage++) {
        const ns = 2 ** stage;
        const from = src;
        const to = 1 - src;

        const pass = Fn(() => {
          const perCascade = uint((n * n) / 2);
          const cascade = instanceIndex.div(perCascade);
          const rest = instanceIndex.mod(perCascade);
          const line = rest.div(uint(half));
          const j = rest.mod(uint(half));

          const index = (i) =>
            horizontal
              ? cascade
                  .mul(uint(n * n))
                  .add(line.mul(uint(n)))
                  .add(i)
              : cascade
                  .mul(uint(n * n))
                  .add(i.mul(uint(n)))
                  .add(line);

          const k = j.mod(uint(ns));
          const angle = float(k).mul(Math.PI / ns);
          const w = vec2(cos(angle), sin(angle));

          const out = j
            .div(uint(ns))
            .mul(uint(ns * 2))
            .add(k);

          const i0 = index(j);
          const i1 = index(j.add(uint(half)));
          const o0 = index(out);
          const o1 = index(out.add(uint(ns)));

          for (const buffer of [a, b]) {
            const v0 = buffer[from].element(i0).toVar();
            const v1 = buffer[from].element(i1);
            const t = vec4(cmul(v1.xy, w), cmul(v1.zw, w)).toVar();
            buffer[to].element(o0).assign(v0.add(t));
            buffer[to].element(o1).assign(v0.sub(t));
          }
        })().compute(this.cascades.length * n * half);

        this.passes.push(pass);
        src = to;
      }
    }

    this.cascades.forEach((_, c) => {
      const assemble = Fn(() => {
        const x = instanceIndex.mod(uint(n));
        const z = instanceIndex.div(uint(n));
        const i = instanceIndex.add(uint(c * n * n));

        // Undo the half-period shift from centring the spectrum.
        const sign = select(
          x.add(z).mod(uint(2)).equal(uint(0)),
          float(1),
          float(-1)
        );

        const p = a[src].element(i).mul(sign);
        const q = b[src].element(i).mul(sign);
        const lambda = this.choppiness;

        // p = (dx, dy, dz, dy/dx)   q = (dy/dz, dx/dx, dz/dz, dx/dz)
        const dxdx = q.y.mul(lambda);
        const dzdz = q.z.mul(lambda);
        const dxdz = q.w.mul(lambda);
        const jacobian = dxdx.add(1).mul(dzdz.add(1)).sub(dxdz.mul(dxdz));

        const texel = ivec2(int(x), int(z));
        textureStore(
          this.displacement[c],
          texel,
          vec4(p.x.mul(lambda), p.y, p.z.mul(lambda), jacobian)
        );
        textureStore(this.derivatives[c], texel, vec4(p.w, q.x, dxdx, dzdz));
      })().compute(n * n);

      this.passes.push(assemble);
    });
  }

  dispose() {
    for (const t of [...this.displacement, ...this.derivatives]) t.dispose();
  }
}
