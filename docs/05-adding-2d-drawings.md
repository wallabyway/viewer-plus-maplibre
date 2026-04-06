# Part 5: Adding 2D — AutoCAD Drawings on the Map

## Beyond 3D: LMV's 2D Pipeline

The technique described in Parts 1–4 focuses on 3D Revit models. But LMV renders 2D drawings too — AutoCAD DWG files, translated into Autodesk's F2D format. These aren't rasterized images. They're vector data with MSDF (Multi-channel Signed Distance Field) encoded text and SDF-encoded polylines, rendered by GPU shaders that produce crisp output at any zoom level.

The question is: can we overlay a 2D construction drawing on a MapLibre map the same way we overlay a 3D building?

The answer is yes — with one critical caveat.

## The `skipCameraUpdate` Problem

In the 3D pipeline (Part 3), we set `viewer.impl.skipCameraUpdate = true` to prevent LMV from overwriting the projection matrix we inject from MapLibre. This works perfectly for 3D because we supply the full view-projection matrix ourselves.

But for 2D views, `skipCameraUpdate` has a hidden side effect. It blocks `updateCameraMatrices()`, which contains the only call path to a critical function: `updatePixelScale()`.

The call chain looks like this:

```
tick()
  └─ skipCameraUpdate? ──YES──> SKIPPED (no pixel scale update)
                         │
                         NO
                         ▼
                    updateCameraMatrices()
                      ├─ getPixelsPerUnit(camera, worldBox)
                      ├─ matman.updatePixelScale(ppu, w, h, camera)
                      ├─ matman.updateSwapBlackAndWhite()
                      └─ forEach 2D model:
                           matman.updatePixelScaleForModel(model, ppu, ...)
```

When `skipCameraUpdate` is true, none of the pixel scale updates fire. The 2D shaders receive stale uniform values, and the drawing renders at the wrong scale.

## What `pixelsPerUnit` Actually Does

LMV's 2D rendering is uniform-driven, not texture-driven. The MSDF/SDF data is baked into vertex buffers at load time by the F2D loader. At render time, the "common line shader" (a 2D-specific material) uses a `pixelsPerUnit` uniform to control:

- **Line weight**: how many screen pixels a line of a given CAD weight should occupy at the current zoom
- **Text rendering**: how the MSDF texture is sampled — higher `pixelsPerUnit` means sharper glyphs
- **Point size**: scaling of point markers relative to the viewport

As the user zooms in on the map, `pixelsPerUnit` increases, and the shader adjusts line thickness and text clarity accordingly. Without this update, zooming in shows blurry text and incorrect line weights — the drawing looks frozen at the initial zoom level.

## The Fix: Manual Pixel Scale Update

Since we can't let LMV run its full `updateCameraMatrices()` (it would overwrite our MapLibre projection), we call the pixel scale update manually inside the `render()` callback:

```javascript
render(gl, args) {
  // ... camera sync (same as 3D) ...

  if (lmvViewer.impl.is2d) {
    const matman = lmvViewer.impl.matman();
    const camera = lmvViewer.impl.camera;
    const renderer = lmvViewer.impl.renderer();
    const w = renderer.settings.deviceWidth;
    const h = renderer.settings.deviceHeight;

    const worldBox = lmvViewer.impl.getVisibleBounds(true);
    const pixelsPerUnit = lmvViewer.impl.getPixelsPerUnit(camera, worldBox);

    matman.updatePixelScale(pixelsPerUnit, w, h, camera);
    matman.updateSwapBlackAndWhite(lmvViewer.impl.swapBlackAndWhite);

    // Per-model update handles scaled sheets (e.g. 1:50 details)
    const models2d = lmvViewer.impl.get2DModels?.();
    if (models2d) {
      models2d.forEach(model => {
        const transform = model.getModelToViewerTransform?.();
        const scaling = transform ? transform.getMaxScaleOnAxis() : 1;
        const bounds = model.getVisibleBounds();
        const ppu = lmvViewer.impl.getPixelsPerUnit(camera, bounds, model);
        matman.updatePixelScaleForModel(model, ppu, w, h, scaling, camera);
      });
    }
  }

  // ... tick + GL state restore ...
}
```

This replicates exactly what `updateCameraMatrices()` does for 2D models, without touching the projection matrix.

## What LMV Does Automatically for 2D

When a 2D model (DWG/F2D) loads through `loadDocumentNode`, LMV's `addModel()` calls `setUp2DMode()` internally. This triggers a chain of setup that happens automatically:

1. **`_materials.initLayersTexture()`** — creates a texture that encodes layer visibility (each AutoCAD layer maps to a texel; the shader samples this to show/hide layers)
2. **`_materials.create2DMaterial()`** — creates the specialized 2D line/text shader material with MSDF support
3. **`_renderer.enter2DMode()`** — switches the render context to 2D mode: disables edge rendering, enables the ID buffer for selection, and sets the `IS_2D` define on the blend shader
4. **Light preset** — sets a flat 2D lighting preset (no shading)
5. **Minimum line width** — reads from the model's SVF metadata (`model.loader.svf.minLineWidth`)

You don't need to call any of these manually. The key thing you *do* need is the per-frame `updatePixelScale` call described above.

## AutoCAD Display Conventions

AutoCAD drawings traditionally use a black background with white lines. When displaying on a map (which has a light background), you'll want to swap these:

```javascript
lmvViewer.impl.swapBlackAndWhite = true;
```

The `updateSwapBlackAndWhite()` call in the render loop propagates this to the shader uniforms. White lines become black, and black fills become white — matching what AutoCAD users expect in a "white background" display mode.

## 2D vs 3D: Detection

LMV sets `viewer.impl.is2d` automatically when a 2D model loads. You can branch on this in your render loop:

```javascript
if (lmvViewer.impl.is2d) {
  // 2D path: update pixel scale, swap black/white
} else {
  // 3D path: standard camera sync
}
```

The camera synchronization (Part 3) works identically for both — the model-to-Mercator matrix is the same. The only difference is the additional pixel scale maintenance for 2D.

## Why This Matters for GIS

Construction drawings — site plans, floor plans, utility layouts — are inherently geographic. A site plan drawn in AutoCAD has a real-world location. Overlaying it on a map connects the drawn geometry to its geographic context: parcel boundaries, roads, existing utilities, satellite imagery.

With the 2D pipeline working on MapLibre, you could overlay a DWG site plan directly on a satellite basemap, with the drawing's line weights and text scaling correctly at any zoom level. The drawing stays vector-sharp because the MSDF/SDF pipeline is resolution-independent — it's the same technology that makes MapLibre's own text labels crisp.

## Key Takeaway

LMV's 2D rendering is driven by a `pixelsPerUnit` shader uniform that must update every frame with the current zoom. The `skipCameraUpdate = true` flag (necessary for 3D camera injection) blocks this update. The fix is a manual call to `updatePixelScale()` in the render loop, replicating the blocked code path. Everything else — materials, shaders, layer textures — is set up automatically by LMV when a 2D model loads.
