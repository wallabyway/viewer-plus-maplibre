# Part 1: Sharing a Single WebGL Context Between Two Renderers

## The Problem

MapLibre GL JS owns a WebGL2 canvas. It draws vector tiles, terrain, and 3D extruded buildings through its own rendering pipeline. Autodesk's APS Viewer (internally called LMV) also has its own WebGL renderer — a heavily modified fork of three.js revision 71 (R71). Both renderers expect to be the sole owner of the GPU context.

We need them to draw into the **same canvas**, in the **same frame**, without corrupting each other.

## Why Not Two Canvases?

Layering a second `<canvas>` on top of MapLibre's seems simpler, but it breaks immediately:

- **No shared depth buffer.** The Revit building can't occlude MapLibre's 3D buildings (or vice versa) because each canvas has its own framebuffer.
- **Compositing artifacts.** Alpha blending between two separate canvases produces incorrect results at semi-transparent edges.
- **Double GPU memory.** Two full-resolution framebuffers for the same viewport.

## The Solution: One Canvas, Two Renderers

MapLibre's `CustomLayerInterface` is the key. It lets you register a custom layer that receives the raw `WebGL2RenderingContext` in its `render()` callback. During that callback, you own the GL context — MapLibre has finished its own drawing for layers below yours and hasn't started layers above.

The trick is constructing LMV's renderer **on MapLibre's canvas** rather than letting it create its own:

```javascript
const sharedRenderer = new LMVRendererClass({ canvas: map.getCanvas() });
```

Both renderers now issue draw calls to the same framebuffer. LMV draws the Revit model; MapLibre draws the map tiles and 3D buildings. The depth buffer is shared, so geometry from one renderer correctly occludes geometry from the other.

## GL State: The Hidden Minefield

WebGL is a state machine. Every `bindBuffer`, `useProgram`, `enable`, and `activeTexture` call changes global state that persists until something else changes it. When two renderers share a context, each one's draw calls leave behind state that the other doesn't expect.

LMV's R71 renderer leaves behind:
- Bound Vertex Array Objects (VAOs)
- Bound ARRAY_BUFFER and ELEMENT_ARRAY_BUFFER
- Active texture units with bound textures
- Framebuffer bindings (from internal FBO passes)
- Shader programs

If MapLibre tries to upload vertex data into what it thinks is its own buffer, but LMV's buffer is still bound, MapLibre writes into LMV's memory. The result: corrupted geometry, WebGL errors, or a crash.

## The State Cleanup Protocol

After every LMV `tick()`, we run a thorough state reset:

```javascript
function restoreGLStateForMapLibre(gl, glr) {
  glr.resetGLState();           // R71's own cleanup (partial)
  gl.bindVertexArray(null);     // Unbind LMV's VAO
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  gl.useProgram(null);
}
```

R71's own `resetGLState()` was written for single-renderer use and doesn't unbind VAOs or WebGL2-specific buffer targets. The additional cleanup lines above cover the gaps.

## Key Takeaway

Sharing a WebGL context between two renderers is possible, but it requires discipline. Every frame is a handoff: LMV draws, cleans up, then MapLibre takes over. If either side leaves dirty state, the other's rendering breaks in subtle, hard-to-debug ways.
