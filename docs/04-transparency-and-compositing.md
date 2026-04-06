# Part 4: Transparency, Compositing, and the GL State Machine

## The Compositing Problem

LMV renders the Revit model into internal framebuffer objects (FBOs) for post-processing, then blits the result onto the canvas in a final `presentBuffer` pass. By default, this blit overwrites whatever MapLibre has already drawn — the map disappears behind a solid background.

We need LMV's output to composite **on top of** MapLibre's map, with the building opaque and the background transparent.

## Step 1: Transparent Background

LMV's default background is a gradient rendered by a shader. We replace it with a simple transparent clear:

```javascript
const rc = viewer.impl.renderer();   // RenderContext
rc.setClearColors(new THREE.Color(0, 0, 0));  // Solid clear, not gradient
rc.setClearAlpha(0);                           // Alpha = 0 (transparent)
viewer.impl.toggleEnvMapBackground(false);     // No environment map
rc.setAOEnabled(false);                        // SSAO writes to background
```

With these settings, every pixel where there's no geometry gets cleared to `rgba(0, 0, 0, 0)` — fully transparent black.

## Step 2: Forcing Alpha Blending on the Blit

LMV's `presentBuffer` draws a fullscreen quad that copies the FBO content to the canvas. Internally, R71's material system sets `transparent = false` on this quad, which means the renderer disables GL blending during the draw call.

With blending disabled, the FBO content **replaces** the canvas content rather than compositing on top. Even though our background is transparent, the `gl.disable(GL_BLEND)` means alpha is ignored.

The fix requires intercepting the WebGL state machine itself:

```javascript
let forceBlend = false;
const origDisable = gl.disable.bind(gl);

gl.disable = function(cap) {
  if (forceBlend && cap === gl.BLEND) return;  // Swallow the call
  origDisable(cap);
};
```

Before calling `presentBuffer`, we enable blending and set our flag:

```javascript
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
forceBlend = true;
origPresent(userFinalPass);
forceBlend = false;
```

During the blit, R71 tries to call `gl.disable(gl.BLEND)`, but our interceptor swallows it. The fullscreen quad draws with alpha blending, so transparent pixels let MapLibre's map show through and opaque pixels (the building) draw on top.

## Why Not Just Set `material.transparent = true`?

R71's blending control lives on an internal `state` object inside the renderer, not on the material itself. The `setBlending` method checks `state.oldBlending` to avoid redundant state changes. Even if you set `material.transparent = true`, R71's internal state tracking may skip the actual `gl.enable(GL_BLEND)` call.

Intercepting `gl.disable` at the WebGL level bypasses all of R71's internal state management. It's blunt but reliable.

## The Depth Buffer and Multisampled Framebuffers

Ideally, we'd also copy LMV's depth buffer to the canvas so MapLibre's 3D extruded buildings depth-test against the Revit model. WebGL2's `blitFramebuffer` can copy depth:

```javascript
gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
```

But there's a catch: MapLibre creates its canvas with `antialias: true`, which makes the default framebuffer multisampled. LMV's internal FBOs are not multisampled. WebGL2 requires matching sample counts for depth blits — the mismatch produces `GL_INVALID_OPERATION`.

The pragmatic solution: detect antialiasing at startup and skip the depth blit if the canvas is multisampled:

```javascript
const canvasMultisampled = !!gl.getContextAttributes().antialias;
if (canvasMultisampled) return; // Skip depth blit
```

This means MapLibre's buildings won't depth-test against the Revit model. A future improvement could use a fullscreen-quad shader that reads LMV's depth texture and writes to `gl_FragDepth`, avoiding `blitFramebuffer` entirely.

## The Frame Sequence

Putting it all together, each frame follows this sequence:

1. **MapLibre renders** its base map (tiles, terrain, layers below the custom layer)
2. **Custom layer `render()` fires** — we now own the GL context
3. **Set LMV's camera** to match MapLibre's view-projection
4. **Reset GL state** so LMV starts from a clean slate
5. **LMV ticks** — renders to internal FBOs, then `presentBuffer` composites onto the canvas with forced alpha blending
6. **Reset GL state again** so MapLibre can safely render layers above (3D buildings)
7. **MapLibre continues** rendering its remaining layers

## Key Takeaway

Making LMV's output transparent requires three coordinated changes: clearing the FBO with alpha zero, intercepting `gl.disable(BLEND)` during the canvas blit, and carefully managing the GL state machine before and after each renderer takes its turn. The WebGL state machine is the shared contract between the two renderers — violate it, and the compositing breaks.
