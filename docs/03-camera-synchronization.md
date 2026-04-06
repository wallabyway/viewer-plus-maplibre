# Part 3: Camera Synchronization — Projecting BIM into Mercator Space

## Two Coordinate Systems

MapLibre works in **Web Mercator** coordinates. The entire world fits in a unit square (0–1 on both axes), and zoom level determines how much of that square is visible. The vertical axis (Z) represents altitude, also in Mercator units.

LMV's Revit model lives in **model space** — typically measured in feet, with Y-up or Z-up orientation depending on the authoring tool. A Revit building might span coordinates like (0, 0, 0) to (200, 150, 40) in feet.

To place the building on the map, we need a transformation chain:

```
Model feet → Meters → Mercator units → Screen pixels
```

## The Model Transform Matrix

We build a 4×4 column-major matrix that converts model-space coordinates into Mercator coordinates and places the model at a specific longitude/latitude:

```javascript
const modelOrigin = [-79.8839, 40.0236]; // Brownsville, PA
const mc = maplibregl.MercatorCoordinate.fromLngLat(modelOrigin, 0);

const scale = mc.meterInMercatorCoordinateUnits() * FEET_TO_METERS;

const modelMatrix = new Float64Array([
  scale,  0,      0,      0,    // X: scale feet → mercator
  0,     -scale,  0,      0,    // Y: flip + scale (Revit Y → Mercator -Y)
  0,      0,      scale,  0,    // Z: scale feet → mercator
  mc.x,   mc.y,   mc.z,   1     // Translation to map position
]);
```

The Y-axis is negated because Mercator's Y increases downward (south), while Revit's Y increases upward (north in plan view).

`meterInMercatorCoordinateUnits()` is the critical bridge function — it returns how many Mercator coordinate units equal one meter at the given latitude. Multiplying by `0.3048` (feet-to-meters) gives us the scale factor from model feet to Mercator units.

## Composing with MapLibre's View-Projection

MapLibre's `CustomLayerInterface` provides its view-projection matrix in the `render()` callback as `args.defaultProjectionData.mainMatrix`. This is a 4×4 Float64Array that transforms Mercator coordinates to clip space.

A naive approach would compose `viewProjection × modelMatrix` directly and set the result as the GPU's projection matrix. This works in Chrome but fails in Safari — the model "swims" relative to the map as the camera orbits.

## The Precision Problem

The model's Mercator position (e.g., `x = 0.33017`) is an absolute coordinate in a world-sized unit square. MapLibre's view-projection matrix contains values on the order of 2^zoom × tileSize (tens of millions at zoom 18). When the GPU multiplies the final Float32 matrix by model vertices, the large absolute translation and the large VP scaling interact through floating-point arithmetic that loses precision.

Chrome's ANGLE-based WebGL has enough precision headroom to hide this. Safari's Metal-backed WebGL does not. The result is visible jitter — the model shifts by a few pixels each frame as the camera moves.

## The Fix: Relative-to-Eye (RTE) Translation

The solution is a technique from GPU globe rendering called **relative-to-eye** (RTE). Instead of encoding the model's absolute Mercator position in the matrix, we express it as a tiny offset from the camera center:

```javascript
const camCenter = map.getCenter();
const camMerc = maplibregl.MercatorCoordinate.fromLngLat(camCenter, 0);

// Tiny offsets — typically < 0.0001 in Mercator units
const dx = modelMerc.x - camMerc.x;
const dy = modelMerc.y - camMerc.y;
const dz = modelMerc.z - (camMerc.z || 0);
```

We then re-center the VP matrix so its origin is the camera's Mercator position:

```javascript
const camTranslate = new Float64Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  camMerc.x, camMerc.y, camMerc.z || 0, 1
]);
const vpCentered = mulMat4Float64(vp64, camTranslate);
```

The model matrix uses the relative offset instead of the absolute position:

```javascript
const modelMatrix = new Float64Array([
  scale,  0,      0,      0,
  0,     -scale,  0,      0,
  0,      0,      scale,  0,
  dx,     dy,     dz,     1
]);

const result = mulMat4Float64(vpCentered, modelMatrix);
camera.projectionMatrix.elements.set(new Float32Array(result));
```

The multiplication is done in Float64. Because the translation values (`dx`, `dy`, `dz`) are tiny, the resulting Float32 matrix has small, well-behaved values throughout. The GPU's Float32 arithmetic stays precise on both Chrome and Safari.

## Zeroing LMV's Camera

R71's renderer auto-computes `matrixWorldInverse = inverse(camera.matrixWorld)` before every draw call. LMV's camera has its own position and orientation from loading the model (it might be at (-178, -232, 185) looking at the model center).

If we don't intervene, the final transform becomes:

```
clip = projection × matrixWorldInverse × vertex
```

That unwanted `matrixWorldInverse` adds an extra view transform that shifts the model away from its geo-pinned location. The fix: force the camera's world transform to identity every frame:

```javascript
cam.position.set(0, 0, 0);
cam.quaternion.set(0, 0, 0, 1);
cam.scale.set(1, 1, 1);
cam.matrixWorld.identity();
cam.matrixWorldInverse.identity();
```

We explicitly reset position, quaternion, scale, and both matrix fields every frame before calling `tick()`. R71 recomputes `matrixWorldInverse` from `matrixWorld` during its render pass, so as long as we set `matrixWorld` to identity, the inverse stays identity too. Importantly, we must leave `matrixAutoUpdate` enabled — disabling it causes R71's internal pipeline to skip steps that result in incorrect camera orientation.

### Pitfall: Don't Disable `matrixAutoUpdate`

It's tempting to set `cam.matrixAutoUpdate = false` to prevent R71 from touching the camera matrices. **Don't.** R71's modified Three.js r71 fork relies on `matrixAutoUpdate` being true to correctly propagate the identity state through its internal render pipeline. Disabling it causes the model to render at a ~45° angle — R71 skips an internal matrix recomputation step that produces a stale `matrixWorldInverse`, which rotates the model. Setting `matrixWorld` and `matrixWorldInverse` to identity manually each frame is sufficient.

## Float64 Precision

At zoom level 18, one Mercator unit spans the entire world (~40,000 km). Model coordinates in Mercator space are tiny numbers like `0.00000012`. The matrix multiply must be done in Float64 to preserve sub-meter precision.

The `mulMat4Float64` function performs both multiplies (VP × camTranslate, then vpCentered × model) in Float64. Only the final 4×4 result is truncated to Float32 for the GPU shader. Combined with RTE, this keeps all Float32 values small enough for accurate rendering on every browser.

## Key Takeaway

Camera sync requires two matrix multiplies: re-centering the VP matrix to the camera's Mercator position, then composing with a model matrix that uses camera-relative translation. The RTE technique eliminates the Float32 precision loss that causes model swimming in Safari. Y-axis flipping handles the Revit-to-Mercator coordinate convention, and zeroing the camera's world transform every frame prevents R71 from injecting its own view transform.
