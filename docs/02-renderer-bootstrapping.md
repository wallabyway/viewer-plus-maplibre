# Part 2: Bootstrapping LMV's Renderer from the CDN Build

## The Challenge

The APS Viewer SDK (LMV) is distributed as a minified CDN bundle (`viewer3D.min.js`). It exposes `Autodesk.Viewing.Viewer3D` as the public entry point, but the internal WebGL renderer class — the modified three.js R71 `WebGLRenderer` — is **not on any public namespace**. There's no `Autodesk.Viewing.Private.FireflyWebGLRenderer` you can just import.

We need that constructor because we have to create a renderer instance that targets MapLibre's existing canvas, not one that creates its own.

## The Bootstrap Trick

The solution: create a throwaway viewer, extract the renderer's constructor from it, then destroy the throwaway:

```javascript
function bootstrapRendererClass() {
  // Hidden 1x1 container — never visible
  const div = document.createElement('div');
  div.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px';
  document.body.appendChild(div);

  // Create a temporary viewer (this initializes LMV's renderer)
  const temp = new Autodesk.Viewing.Viewer3D(div);
  temp.start();

  // Grab the constructor from the live instance
  const RendererClass = temp.impl.glrenderer().constructor;

  // Tear down the throwaway
  temp.finish();
  document.body.removeChild(div);

  return RendererClass;
}
```

`temp.impl.glrenderer()` returns the live `FireflyWebGLRenderer` instance. Its `.constructor` gives us the class itself. Now we can call `new RendererClass({ canvas: maplibreCanvas })` to create a renderer on any canvas we choose.

## Protecting the Canvas: setSize Override

When LMV creates a viewer, it calls `renderer.setSize()` during initialization, passing the container's dimensions. Our hidden container is 1×1 pixels. If that propagates to the shared renderer, it would resize MapLibre's canvas to 1×1, destroying the map.

The fix is a one-line override:

```javascript
renderer.setSize = function() {
  renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
};
```

This converts `setSize` into a viewport-only update. The canvas DOM element keeps its original dimensions. LMV thinks it resized; MapLibre's layout is untouched.

## FBO Resize

LMV's `RenderContext` creates internal framebuffer objects (FBOs) for post-processing passes (SSAO, tone mapping, anti-aliasing). These FBOs are sized during viewer creation at the container's dimensions — again, 1×1.

After creating the viewer, we explicitly resize the FBOs to match the map canvas:

```javascript
const w = mapCanvas.clientWidth;
const h = mapCanvas.clientHeight;
viewer.impl.resize(w, h, true);
```

Without this, LMV renders a full Revit model into a 1×1 pixel framebuffer and then blits a single pixel onto the map.

## Stopping LMV's Own Render Loop

LMV normally runs its own `requestAnimationFrame` loop. Since MapLibre controls the render timing (it calls our `render()` method), we need to prevent LMV from ticking independently:

```javascript
viewer.impl.stop();                  // Cancel LMV's own rAF loop
viewer.impl.skipCameraUpdate = true; // We'll set the camera ourselves
```

Now LMV only renders when we explicitly call `viewer.impl.tick()` inside MapLibre's custom layer callback.

## Key Takeaway

LMV's CDN build hides its renderer class, but a throwaway viewer instance exposes it through `impl.glrenderer().constructor`. With the constructor in hand, we can create a renderer on any canvas — including MapLibre's. Protecting the canvas from LMV's size management and disabling its autonomous render loop are essential to making the two systems coexist.
