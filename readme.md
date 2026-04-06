# Putting a Revit Building on a MapLibre Map — By compositing with Autodesk's LMV Renderer

**What if you could drop a full BIM model onto an open-source web map — not as a static 3D mesh, but rendered by the same engine Autodesk uses in production?**

![Image](https://github.com/user-attachments/assets/40415321-8288-4977-a7eb-028ea846dd79)

Three weeks ago I was at the Esri Developer Summit in Palm Springs. [George Owen](https://www.esri.com/arcgis-blog/author/gowen) took the stage to demo the [MapLibre ArcGIS Plug-in](https://registration.esri.com/flow/esri/26epcdev/deveventportal/page/detailed-agenda/session/1761020020865001l0Ts) — Esri's official bridge for bringing [ArcGIS services into MapLibre GL JS](https://developers.arcgis.com/maplibre-gl-js/) ([blog post](https://www.esri.com/arcgis-blog/products/platform/developers/new-maplibre-gl-js-plugin-for-open-source-developers)). It was compelling. Esri is investing in open-source mapping, and MapLibre's `CustomLayerInterface` is the hook that makes it possible.

I walked out of that session thinking: *if Esri can inject ArcGIS into MapLibre's WebGL context, what else can we inject?*

I've been exploring the intersection of BIM and GIS for a while now. An earlier experiment used [geo-three](https://github.com/nicejam/geo-three) to render Esri's World Elevation terrain tiles in a three.js scene — proof that geospatial data and 3D rendering can mix. But terrain is one thing. A full Revit building — with thousands of parametric elements, materials, and metadata — is another.

This post describes what happened when I tried to render an Autodesk Revit model on a MapLibre map by making MapLibre and LMV (Autodesk's internal viewer engine) share a single WebGL context. Not a screenshot overlay. Not an iframe. **Two renderers, one canvas, one depth buffer.**

### Live Demo

> **[Try it live →](https://wallabyway.github.io/viewer-plus-maplibre/)**

https://github.com/user-attachments/assets/dbfd6865-26f8-41ab-8bc8-cba35ceaa133


---

## Setup & Running

```bash
cd blog
npm install
npm run dev
```

This starts a Vite dev server on `http://localhost:5180` with a proxy to the APS public demo API (no API key required). Open the URL shown in the terminal.

The demo loads the **Snowdon Towers** Revit model from Autodesk's sample bucket and places it on a MapLibre map with 3D terrain at Brownsville, PA. Use the dropdown to switch between available models. The LMV viewer UI (toolbar, model browser, properties panel) is overlaid on the map.

![Snowdon Tower cover page](docs/snowdon-tower-coverpage.png)
![Snowdon Tower site location](docs/snowdon-tower-location-sitemap.png)

Geo-pinned in [`main.mjs`](https://github.com/wallabyway/viewer-plus-maplibre/blob/55fcaa06413022b6920e712fad5c4f1e03911252/main.mjs#L28-L32):

```javascript
const modelOrigin = [-79.88666527, 40.022371938];
const modelAltitude = 10;
const modelRotationDeg = 30;
```

### Requirements

- Node.js 18+
- A modern browser with WebGL2 support

---

## Why This Matters

AEC (Architecture, Engineering, and Construction) firms live in two worlds. Their building models are in Autodesk Revit, Navisworks, and the APS platform. Their site context — terrain, parcels, utilities, satellite imagery — is in GIS systems, often powered by Esri. Connecting these worlds usually means exporting, converting, and losing fidelity.

What if the building could render *natively* on the map, using the same renderer that powers the APS Viewer? No format conversion. No geometry extraction. The actual LMV engine, drawing into MapLibre's canvas.

That's what this demo does.

## The Approach

MapLibre GL JS supports custom WebGL layers through its `CustomLayerInterface`. You register a layer object with `onAdd()` and `render()` methods. Inside `render()`, you receive the raw `WebGL2RenderingContext` and MapLibre's view-projection matrix. You can draw whatever you want.

The APS Viewer SDK (aka LMV) uses a modified fork of three.js revision 71 as its rendering engine. We extract LMV's constructor from a throwaway viewer instance and create a new one targeting MapLibre's canvas.

The full technique breaks down into five parts:

### [Part 1: Sharing a Single WebGL Context](docs/01-shared-webgl-context.md)

Two renderers on one canvas. The WebGL state machine is global — every `bindBuffer` and `useProgram` persists until something changes it. After each renderer draws, we need a thorough state cleanup to prevent one from corrupting the other.

### [Part 2: Bootstrapping LMV's Renderer](docs/02-renderer-bootstrapping.md)

The bootstrap trick: create a throwaway viewer, grab `impl.glrenderer().constructor`, destroy the throwaway. Now we can construct a renderer on the mapLibre canvas.

### [Part 3: Camera Synchronization](docs/03-camera-synchronization.md)

A Revit model is in feet. MapLibre is in Web Mercator. The bridge is a matrix multiply: `vpCentered × modelTransform`, where the VP is re-centered to the camera's Mercator position and the model matrix uses a tiny relative offset instead of absolute coordinates. This **relative-to-eye (RTE)** technique keeps Float32 values small, eliminating the "swimming" precision artifacts that appear in Safari when using absolute Mercator positions. Float64 precision during composition and zeroing LMV's camera world transform every frame complete the fix.

### [Part 4: Transparency and Compositing](docs/04-transparency-and-compositing.md)

LMV renders to internal framebuffers, then blits to the canvas. By default, this overwrites MapLibre's map. Making it transparent requires clearing with alpha zero, grabbing `gl.disable(BLEND)` during the blit, and managing the depth buffer across multisampled framebuffer boundaries.

### [Part 5: Adding 2D — AutoCAD Drawings on the Map](docs/05-adding-2d-drawings.md)

It's not just 3D. LMV also renders 2D AutoCAD drawings using an MSDF/SDF shader pipeline that produces vector-sharp text and lines at any zoom. The trick is maintaining the `pixelsPerUnit` uniform that drives zoom-dependent rendering quality — a code path that our camera injection accidentally blocks.

---

## The Result

A Revit building rendered on a MapLibre map at Brownsville, PA. The model is geo-pinned — pan, zoom, and rotate the map and the building moves with it. MapLibre's 3D extruded buildings render alongside. The model loads from Autodesk's cloud through the standard APS document loading pipeline.

The entire implementation is under 300 lines across two files (`main.mjs` and `lmv-loader.mjs`).


---

## Source

The complete source code for this demo is in this repository. The key files:

- [`main.mjs`](main.mjs) — MapLibre custom layer, camera sync, model loading
- [`lmv-loader.mjs`](lmv-loader.mjs) — LMV initialization, renderer injection, transparency patches
- [`index.html`](index.html) — Minimal UI with model picker
