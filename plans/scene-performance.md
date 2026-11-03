## Scene performance: low-hanging fruit

Nothing in the scene has been tuned for speed yet. This is a read-through of the code with a Three.js / WebGPU performance lens: obvious wins, shaders worth consolidating, and load-time fixes, roughly in order of payoff per hour. There's no profiling here. Each item says why it costs and what to change, and the fixes are meant to be picked off one per session.

Paths are from `src/components/scene/` unless they say otherwise.

### Progress (2026-11-03)

Measured at 1280×800, DPR 2 screen, harbour view. fps sits near 30, probably held there by vsync, so it's a rough measure.

- **6 done.** `visibility.ts`: the canvas goes `frameloop="never"` off screen, and the polls check `sceneShown()`. Scrolled away: 0 GPU submits and 0 polls.
- **1 done, in part.** The rain pass now uses `samples: 0`, and desktop DPR is capped at 1.5. `antialias: true` stays: r186 already draws the output quad without MSAA (`currentSamples` is 0 for fullscreen passes), and `LatticeTower` and `LandmarksPreview` depend on `renderer.samples`. fps went from 25/21/24 to 30/26/31 (noon/night/rain).
- **4 done, in part.** The ocean's compute passes run as one call. Mip regeneration is untouched. Under `?webgl` the water was already flat before this change.
- **2 done, in part.** The near map re-renders when the fit changes, every frame while a turbine is inside it (`addRestlessCasters`), and otherwise every 0.1 s. Tree shadows lean without the sway. Still open: shadow map size 2048 (trades sharpness), and casting only from tiles inside `fullDistance`.
- **5 done, in part.** Fog, sky and cloud-march glow sit behind a branch on `windowLights` (`whileLit` in `skyglow.ts`), so their code doesn't change at dusk. The dusk frame went from 634 ms to 332 ms. Bloom is still built only at night, and the rest of the hitch is probably night-only materials compiling for the first time (item 15).
- **3 done.** Buildings are `FrontSide` with no tile rebuild: the builder already winds roofs and walls outward, and the reflection is unaffected. About +1–1.5 fps.
- **three r187** (pinned). The Inspector's circular-import bug under Turbopack is fixed in this release.
- **`?stats`**: three's Inspector, plus a readout of render calls, draws and triangles. Its per-pass GPU times are meaningless on M1, because on a tiled GPU each pass's timestamps take in most of the frame. **`?off=part,…`** turns parts off instead, so each one's cost shows as the frame time it gives back (`terrain`, `ocean`, `landmarks`, `buildings`, `trees`, `airfield`, `vessels`, `railway`, `traffic`, `buses`, `flights`, `dof`, `clouds`, `reflection`, `nearshadow`).
- **What each part costs** (M1, 1280×800 at DPR 1.5, about 32 ms a frame, 7.5 ms of it JS). City view / harbour view:
  - terrain 15.1 / 13.3 ms
  - ocean 8.8 / 9.3
  - depth of field 2.8 / 3.8
  - reflection 1.9 / 2.1
  - landmarks 1.7
  - near shadow 1.4
  - buildings 1.2 / 0
  - trees 0.3 / 0.5
  - clouds 0.3 (clear sky)
  - traffic and vessels about 0

  Terrain is mostly vertex work: `gridSize: 32` gave back 8.3 ms. So item 11 is worth a millisecond or two at most. The terrain's 16-tap B-spline per vertex and the ocean come first.

- **Second round (same day).** The city view went from 33.5 ms to 17.0 ms at 1280×800 (about 59 fps), and is 18.7 ms full-screen at 1440×900. JS went from 6.7 to 3.6 ms a frame (CDP sampling profile).
  - **Terrain:** height and gradient are sampled once per vertex and passed down as varyings (about 2 ms; before, the pixels re-ran all 16 taps). Desktop `gridSize` is now 32: close up, patches still split down to the data's spacing, and no difference shows in screenshots (about 8 ms).
  - **Ocean:** desktop `fftSize` is 128 (about 4 ms). At 256, the 16 Stockham passes stream every buffer through memory each frame, so it's bandwidth-bound. Mipmaps are cheap (0.4 ms), and so are the depth copy (0.3) and shadow sampling (0.4). The fix that keeps 256 is a workgroup shared-memory FFT: 2 dispatches instead of 16 ([Poseidon](https://github.com/owenyuwono/poseidon/wiki) and [web-ocean](https://raw.githubusercontent.com/Noniv/web-ocean/main/README.md) are WebGPU references).
  - **Reflection:** now about 0.6 ms, nearly all of it buildings. A smaller render bought nothing, so item 14 is low value.
  - **Depth of field:** our own version in `lens.ts`, the same algorithm as three's dof node (64-tap average, then the brightest of 16 taps for bokeh), but three half-size passes instead of seven, two of which were full size. It looks the same in screenshots, sun glints included, and costs about 0.9 ms against 2.7.
  - **Matrices:** the scene root, building tiles and tree tiles have `matrixAutoUpdate = false`. Otherwise the root's own update made three recompute every world matrix every frame (about 0.4 ms).
  - **`DynamicDrawUsage` removed everywhere.** In three's WebGPU renderer it re-uploads the whole buffer on every draw, whatever the version. Flight trails alone sent 2 MB a frame. Uploads fell from 2.4 MB to 0.2 MB a frame. Don't reintroduce it; `needsUpdate` already drives uploads.
  - **JS left** (about 3.6 ms): the traffic sim (`drive`, about 0.6 ms, plus `Vehicles.useFrame` and `placeAt`), three's per-object render bookkeeping, and `updateMatrixWorld` for what still moves.

- **7 done, in part.** Terrain patch upload writes components directly and uses update ranges, the caster signature is a number compare, and the options spreads are hoisted (Terrain, Buildings). Not done: buses, trains, flights and vessels buffers, trails, the trees walk, and the buildings preload (`request()` may be what keeps those tiles in the LRU).

### What a frame costs today

Every frame, in order:

1. **Ocean FFT.** 20 separate `renderer.compute()` calls (spectrum, 16 Stockham stages, 3 assembles). Then full mip chains are regenerated for the 6 storage textures, because `mipmapsAutoUpdate` defaults on.
2. **Cloud shadow map.** 256², redrawn every 0.2 s. Cheap.
3. **Near shadow map.** 4096² on desktop, **re-rendered every frame**. Its casters are every resident building tile (up to 2.5M triangles), every drawn tree on desktop, turbines, towers, cranes, the container yard, lighthouses, buses and trains.
4. **Sun shadow map.** 4096², only when the sun moves or casters change. This is already good.
5. **Scene pass.** HalfFloat, **4× MSAA inherited from `antialias: true`**, at DPR up to 2. Inside it:
   - the water's reflector re-renders the sky, the terrain stand-in and (on desktop) every building tile, at 0.35 scale;
   - the ocean's `viewportLinearDepth` forces a copy of the depth buffer partway through the pass.
6. **Clouds.** Raymarched at 0.5 × CSS resolution (up to 112 steps × 4 light steps × 2 layers), then a Gaussian blur.
7. **Bloom**, at night only.
8. **Depth of field**, always on, mobile included.
9. **Rain pass**, when raining: a second full-resolution, 4× MSAA scene pass that holds only the drops.
10. **Output.** The final quad goes to a canvas that is itself MSAA.

On the CPU, about 15 `useFrame` callbacks rebuild instance buffers, walk tile lists and allocate small arrays every frame.

---

### Tier 1: quick wins (an hour or two each)

#### 1. Stop paying for 16 samples per CSS pixel

`WellingtonScene.tsx:717,724`: the desktop DPR is `[1, 2]` with `antialias: true`. `PassNode` copies `renderer.samples` (`node_modules/three/src/nodes/display/PassNode.js:800`), so on a retina screen the scene pass is 2×2 pixels × 4 MSAA samples, all HalfFloat. The canvas's own MSAA is also wasted, since all it receives is a full-screen quad.

- Create the renderer with `antialias: false`, and ask for MSAA explicitly where it's wanted: `pass(scene, camera, { samples: 4 })` in `clouds/Clouds.tsx`.
- Give the rain pass `samples: 0` (`clouds/Clouds.tsx:187`). Drops are soft streaks, so MSAA adds nothing.
- Cap desktop DPR at 1.5, or use drei's `<PerformanceMonitor>` / `<AdaptiveDpr>` to drop it under load. With MSAA on, DPR 2 buys very little.
- Check: compare screenshots at `?t=` dusk and noon before and after (see the scene-screenshots memory).

#### 2. Don't re-render the near shadow map every frame

`landmarks/nearShadow.ts:109` sets `shadow.needsUpdate = true` unconditionally. That re-rasterises a 16M-texel depth map holding every building tile and up to 800k trees every frame, just so turbine rotors and buses can move.

- Re-render only when something it shows has changed: the fit changes (snapped centre, extent step or sun direction), or a moving caster sits inside the square. Turbines are at Brooklyn, West Wind and Mill Creek, so from the city they're usually outside it.
- Buses and trains are the only moving casters in town. Refresh at about 10 Hz when only they're moving; a 100 ms lag on a bus's shadow won't show.
- Drop `shadowMapSize` to 2048 on desktop (`WellingtonScene.tsx` passes 4096 to `Landmarks`). At the near map's extents that's still a texel of 0.6–8 m.
- Trees: give the tree material a `castShadowPositionNode` without the wind sway (`trees/material.ts:188`), and cast only from tiles inside `fullDistance`.

#### 3. Draw buildings single-sided

`buildings/material.ts:200` draws buildings with `side: DoubleSide`, because face winding isn't trusted. That doubles their rasterisation in the main pass, the near shadow and the reflection, and turns off back-face culling for 2.5M triangles.

- Fix the winding in `scripts/buildings/` (orient each wall outward from its footprint's centroid, and roofs up), rebuild the tiles, then switch to `FrontSide`.
- Until then, setting `material.shadowSide = FrontSide` at least halves the shadow cost. Some walls with bad winding may then go missing from shadows.

#### 4. Batch the ocean's compute passes

`ocean/OceanSimulation.ts:96` calls `renderer.compute(pass)` 20 times. `Renderer.compute` accepts an array (`Renderer.js:2916`) and runs it as one compute pass, so change the call to `renderer.compute(this.passes)`.

Separately, decide whether every texture needs its mips regenerated every frame. Displacement is read at `.level(0)` in the vertex shader, but its `.w` (the jacobian) is also read in the fragment shader with mips. Derivatives do want mips. If dropping some regeneration doesn't add visible shimmer, set `mipmapsAutoUpdate = false` on the textures that don't need it.

#### 5. Don't recompile every material at dusk, or when rain starts

- In `WellingtonScene.tsx:109`, `night` switches `scene.fogNode`. **Every material in the scene** compiles its fog, so all of them recompile when lights come on: a multi-second stall right at golden hour. Build the fog once, with the glow term behind a uniform: `If(nightUniform > 0)`, or multiply by it. `hazeGlow` costs 5 texture taps per fragment (`skyglow.ts:48`), so a uniform branch is better than always paying for it.
- `clouds/Clouds.tsx:211`: `dark` and `raining` are `useMemo` dependencies, so either one rebuilds the whole `RenderPipeline`, the cloud raymarch and the blur and bloom chains. Build the drops pass and the bloom once, and gate them by uniform strength or by `visible` and `instanceCount`. `nightGlow` already takes a uniform strength.
- `cloudNode`'s `night` flag adds the glow to the march at build time. Change it to a uniform-scaled term too.

#### 6. Pause when nobody's looking

The scene is the homepage hero (`src/pages/index.tsx:72`). Scrolled past it, the scene still renders every frame and still polls six live feeds.

- Use an `IntersectionObserver` on the hero to set R3F `frameloop="never"` when it's off screen, and `"always"` when it's back.
- Pause the polling hooks (`*/use*.ts`, plus `weather.ts`) while `document.hidden` or off screen, and poll once on return. Their 10 s cadences also re-render React and rebuild trails on the main thread.
- This saves battery and data more than frames, and it's the cheapest item on the list.

#### 7. Remove per-frame allocations and wasted uploads

All small, and best done together:

- `terrain/Terrain.tsx:540-570`: the caster "signature" `join()`s a string of hundreds of entries every frame. Compare `cache.version` plus the node count instead.
- `terrain/Terrain.tsx:378`: `a.set([...])` allocates two arrays per patch per frame, for up to about 1,100 patches across main, reflection and caster. Write the components directly, call `addUpdateRange(0, count * 4)`, and skip the upload when the selection hasn't changed.
- `{ ...quality, verticalScale }` spreads every frame in Terrain (×2) and Buildings. Hoist them and mutate in place.
- `buildings/Buildings.tsx:175`: about 730 preload tiles are `request()`ed every frame forever. Stop once they're all resident.
- Instance buffers are always uploaded whole, sized at MAX. Buses (`:302-305`), Trains (`:514-518`), Flights and Vessels mark full buffers dirty each frame. Do as Traffic already does (`traffic/Traffic.tsx:493`): `clearUpdateRanges()`, then `addUpdateRange(0, n * itemSize)`. Trail rebuilds on each poll (65,536 × 6 floats for buses) should get the same treatment.
- Trees (`trees/Trees.tsx:188`) box-test all 957 tiles every frame. Skip the walk when the camera hasn't moved.

---

### Tier 2: consolidation (shaders and draw calls)

#### 8. One lamp material

There are about nine `SpriteNodeMaterial` variants, all built from `lamps.ts` (`lampGlow`, `distantDim`, `rowShare`):

`airport/AirfieldLights`, `buildings/lights`, `flights/Flights`, `landmarks/Lighthouses`, `landmarks/ObstructionLights`, `traffic/Traffic` (heads and tails), `trains/Trains` (also used by buses through `createRunLights`), and `vessels/Vessels`.

Each one is its own pipeline to compile, and each layer adds a draw call. Define one lamp material over a shared per-instance layout: position, colour, size, intensity, and flash pattern or phase. Layers keep writing their own buffers, which can later be appended into one buffer and drawn in a single call.

Do the differences first: lighthouse beams, aviation flash patterns and traffic's `rowShare` probably become per-instance parameters and a pattern id.

#### 9. One trail material

`TrailMaterial` is created three times (flights, vessels, and trains plus buses), with the colour, opacity, width and fade baked into each. Give it a per-instance colour and opacity, and a per-instance fade, since flights fade by time and distance and the others by age. Then all trails can share a single `Line2` and one draw call.

#### 10. One vehicle body material

Buses and trains already share car geometry. Traffic has 2 `MeshStandardNodeMaterial`s, Vessels 3 and Flights 1. Most of the differences are tint and windows. One vehicle material with per-instance tint and part flags would cut 6–7 pipelines down to 1–2.

#### 11. Merge tiles into fewer draws: trees and buildings

Every tree tile (957) and building tile (2,253, with a separate lights sprite per tile) is its own `Mesh`, so hundreds of draws are visible at once. Each is drawn in the main pass and the near shadow, and buildings in the reflection too.

- **Trees.** When the set of visible tiles or their counts change, which is rare, copy their instances into one large dynamic `InstancedBufferAttribute`. Draw it as a single mesh. At 8 bytes per tree, recopying 100k trees is under 1 MB.
- **Buildings.** Try `BatchedMesh` (`WebGPURenderer` supports it), or merge siblings under their parent tile. Building lights can go into the same buffer as the shared lamp material (item 8).

#### 12. Atmosphere as one post pass (bigger; consider)

Fog is part of every material: `hazeTransmittance`, `hazeColor`, the edge fade, and at night the 5-tap `hazeGlow`. It runs for every fragment, overdraw included, and every material's shader has to carry it.

The cloud pass already rebuilds world position from scene depth, so haze could be applied there in one full-screen pass. That gives shorter shaders, faster compiles and no overdraw cost.

The catch is anything that doesn't write depth: additive lamps and trails would be fogged as if they sat at the depth behind them. They'd need to keep their own haze, as Trains already does with `hazeTransmittance`.

#### 13. Ocean without the depth copy

`ocean/Ocean.tsx:256` uses `viewportLinearDepth`, which copies the MSAA depth buffer in the middle of the scene pass every frame. The shader already samples bathymetry (`depthAt`). Estimate water thickness from bathymetry depth and the view angle (`depth / max(view.y, ε)`) instead, and drop the copy.

Shore foam would then follow the bathymetry's coastline rather than the drawn terrain's. That's worth a screenshot comparison, because the two may disagree by a few metres.

#### 14. A lighter reflection

On desktop the reflector draws every visible building tile at full detail (`buildings/Buildings.tsx:32`). Put only the coarse building levels (≤ 6) on `REFLECTION_LAYER`, since waves blur everything anyway.

Also consider re-rendering the reflection every other frame when the camera is still.

---

### Tier 3: load time

#### 15. Compile shaders before first show

Dozens of node materials compile on the first frame each one is visible: a long stall at startup, then hitches as layers stream in. Once the layers have mounted, call `await renderer.compileAsync(scene, camera)`, and fade the canvas in when it resolves.

Items 5 and 8–10 shrink the amount there is to compile.

#### 16. Stagger startup fetches

Everything fetches the moment it mounts:

- terrain tiles;
- the buildings manifest (174 KB) and about 730 preload tiles (about 4 MB);
- the trees manifest;
- `landcover.png` (1.3 MB), `water.png` and `shore.png`;
- the airport PNGs;
- `roads.json` (580 KB), `rail/network.json` (760 KB) and `buses/routes.json` (700 KB);
- six live API polls.

Let terrain and the in-view buildings go first. Defer roads, rail, buses, traffic, vessels and flights until the first terrain frame draws, or to `requestIdleCallback`.

#### 17. Get parsing off the main thread

- The three network JSONs are about 2 MB of `JSON.parse` plus geometry building on the main thread. Ship them as quantised binary (as the trees and buildings are), or parse and build in a worker.
- Building tiles are meshopt-decoded on the main thread (`buildings/tiles.ts`). The bundled decoder has `MeshoptDecoder.useWorkers(n)`. The lights decode loop also allocates per light, so write into the `Float32Array` directly.
- `skyglow.ts` `setCityLights` blurs on the main thread when buildings load. Check how long it takes, and move it to a worker if it's noticeable.

#### 18. Halve the terrain texture memory

`terrain/TileCache.ts:88` stores heights as `Float32`: 256 slots × 259² × 4 B ≈ **69 MB of GPU memory, plus the same again as the CPU mirror**. The ground texture adds another 34 MB of each.

The source values are already 16-bit (`q / 32 - 1000`). Store them as `R16UI`, decode in the shader (`float(q) / 32 - 1000`) and in `heightAt`. That's lossless and halves both copies. Also check whether 256 resident slots are needed on desktop, given `maxNodes` 800 at `lodFactor` 2.5.

---

### Tuning knobs to look at, not fixes

These could swing a lot, but only a profile will say. Note them and try each with a quick before/after look:

- **Terrain tessellation.** Desktop is 64² vertices per patch, up to 800 patches, and every vertex does a 16-tap B-spline. That could be over 3M vertex fetches × 16. Try `gridSize: 32` with a higher `lodFactor`.
- **Cloud steps.** Desktop uses 112. Temporal reprojection (march a quarter of the pixels each frame and reproject) is the standard big win, but it isn't low-hanging.
- **Depth of field on mobile.** `DepthOfFieldNode` is several passes. Consider dropping it from `*_MOBILE`.
- **`matrixAutoUpdate = false`** on static objects: tile meshes, road chunks, landmarks. Thousands of objects are walked in each `render()` call.

### Already fine (don't re-litigate)

- The sun shadow map renders only on change, using a coarse caster stand-in.
- Clouds march at reduced resolution scaled by CSS pixels, check 2D coverage before 3D noise, and break out on transmittance.
- Terrain decode, cloud noise and detail maps are built in workers.
- Traffic already uses update ranges and builds road chunks one per frame.
- The trail material avoids `Line2NodeMaterial`'s copy of the opaque scene.
- Reflection samples are 0 and its resolution scale is low.

### Suggested order

1. Items 6, 1 and 4: trivial, and they help everyone.
2. Items 2 and 5: the biggest wins left, and the dusk hitch is visible to users.
3. Item 7, all in one sweep.
4. Items 15 and 16, for first impressions.
5. Item 3 (asset rebuild) and item 18.
6. Items 8–11, the consolidation work, as one refactor.
7. Items 12–14 once there's a profiler in the loop.

To measure cheaply in the meantime, put `renderer.info.render.drawCalls` and triangle counts in an overlay behind `?stats`. That's enough to confirm items 2, 3, 11 and 14 without any frame-timing work.
