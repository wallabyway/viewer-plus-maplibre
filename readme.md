# Putting a Revit Building on a MapLibre Map — By compositing with Autodesk's LMV Renderer

**What if you could drop a full BIM model onto an open-source web map — not as a static 3D mesh, but rendered by the same engine Autodesk uses in production?**

Three weeks ago I was at the Esri Developer Summit in Palm Springs. [George Owen](https://www.esri.com/arcgis-blog/author/gowen) took the stage to demo the [MapLibre ArcGIS Plug-in](https://registration.esri.com/flow/esri/26epcdev/deveventportal/page/detailed-agenda/session/1761020020865001l0Ts) — Esri's official bridge for bringing [ArcGIS services into MapLibre GL JS](https://developers.arcgis.com/maplibre-gl-js/) ([blog post](https://www.esri.com/arcgis-blog/products/platform/developers/new-maplibre-gl-js-plugin-for-open-source-developers)). It was compelling. Esri is investing in open-source mapping, and MapLibre's `CustomLayerInterface` is the hook that makes it possible.

I walked out of that session thinking: *if Esri can inject ArcGIS into MapLibre's WebGL context, what else can we inject?*

I've been exploring the intersection of BIM and GIS for a while now. An earlier experiment used [geo-three](https://github.com/nicejam/geo-three) to render Esri's World Elevation terrain tiles in a three.js scene — proof that geospatial data and 3D rendering can mix. But terrain is one thing. A full Revit building — with thousands of parametric elements, materials, and metadata — is another.

This post describes what happened when I tried to render an Autodesk Revit model on a MapLibre map by making MapLibre and LMV (Autodesk's internal viewer engine) share a single WebGL context. Not a screenshot overlay. Not an iframe. **Two renderers, one canvas, one depth buffer.**

### Live Demo

> **[Try it live →](https://TODO-gh-pages-url)**

https://github.com/user-attachments/assets/placeholder

https://user-images.githubusercontent.com/placeholder/lmv-with-ui.mp4

<video src="docs/lmv-with-ui.mp4" controls width="100%"></video>

---

## Setup & Running

```bash
cd blog
npm install
npm run dev
```

This starts a Vite dev server on `http://localhost:5180` with a proxy to the APS public demo API (no API key required). Open the URL shown in the terminal.

The demo loads the **Snowdon Towers** Revit model from Autodesk's sample bucket and places it on a MapLibre map with 3D terrain at Brownsville, PA. Use the dropdown to switch between available models. The LMV viewer UI (toolbar, model browser, properties panel) is overlaid on the map.

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

The APS Viewer SDK (code-named LMV) uses a heavily modified fork of three.js revision 71 as its rendering engine. LMV doesn't expose this renderer publicly in the CDN build — but we can extract its constructor from a throwaway viewer instance and create a new one targeting MapLibre's canvas.

The full technique breaks down into five parts:

### [Part 1: Sharing a Single WebGL Context](docs/01-shared-webgl-context.md)

Two renderers on one canvas. The WebGL state machine is global — every `bindBuffer` and `useProgram` persists until something changes it. After each renderer draws, we need a thorough state cleanup to prevent one from corrupting the other.

### [Part 2: Bootstrapping LMV's Renderer](docs/02-renderer-bootstrapping.md)

LMV's renderer class isn't on any public namespace. The bootstrap trick: create a throwaway viewer, grab `impl.glrenderer().constructor`, destroy the throwaway. Now we can construct a renderer on any canvas we choose.

### [Part 3: Camera Synchronization](docs/03-camera-synchronization.md)

A Revit model is in feet. MapLibre is in Web Mercator. The bridge is a matrix multiply: `vpCentered × modelTransform`, where the VP is re-centered to the camera's Mercator position and the model matrix uses a tiny relative offset instead of absolute coordinates. This **relative-to-eye (RTE)** technique keeps Float32 values small, eliminating the "swimming" precision artifacts that appear in Safari when using absolute Mercator positions. Float64 precision during composition and zeroing LMV's camera world transform every frame complete the fix.

### [Part 4: Transparency and Compositing](docs/04-transparency-and-compositing.md)

LMV renders to internal framebuffers, then blits to the canvas. By default, this overwrites MapLibre's map. Making it transparent requires clearing with alpha zero, intercepting `gl.disable(BLEND)` during the blit, and managing the depth buffer across multisampled framebuffer boundaries.

### [Part 5: Adding 2D — AutoCAD Drawings on the Map](docs/05-adding-2d-drawings.md)

It's not just 3D. LMV also renders 2D AutoCAD drawings using an MSDF/SDF shader pipeline that produces vector-sharp text and lines at any zoom. The trick is maintaining the `pixelsPerUnit` uniform that drives zoom-dependent rendering quality — a code path that our camera injection accidentally blocks.

---

## The Result

A Revit building rendered on a MapLibre map at Brownsville, PA. The model is geo-pinned — pan, zoom, and rotate the map and the building moves with it. MapLibre's 3D extruded buildings render alongside. The model loads from Autodesk's cloud through the standard APS document loading pipeline.

The entire implementation is under 300 lines across two files (`main.mjs` and `lmv-loader.mjs`).

## The Esri Connection

This experiment wouldn't exist without [George Owen's](https://www.esri.com/arcgis-blog/author/gowen) Esri Dev Summit talk. Seeing ArcGIS layers injected into MapLibre through `CustomLayerInterface` made the architecture click. The same pattern that Esri uses for basemap tiles — registering a custom WebGL layer — works for injecting an entirely different 3D renderer.

The broader vision: AEC firms already use Esri for GIS and Autodesk for BIM. If both can render natively in MapLibre, the open-source map becomes the meeting point. No proprietary viewer lock-in. No export pipelines. Just two renderers sharing a canvas.

I hope this contribution is useful to the MapLibre community and helps strengthen the partnership between the AEC and geospatial ecosystems.

---

## Technical Details

For the full technical deep-dive, see the five-part explainer series in the [`docs/`](docs/) folder. These documents are also available as audio explainers via NotebookLM.

| Part | Topic |
|------|-------|
| [01](docs/01-shared-webgl-context.md) | Sharing a single WebGL context between two renderers |
| [02](docs/02-renderer-bootstrapping.md) | Bootstrapping LMV's hidden renderer class from the CDN |
| [03](docs/03-camera-synchronization.md) | Camera sync — projecting BIM coordinates into Mercator space |
| [04](docs/04-transparency-and-compositing.md) | Transparency, compositing, and GL state management |
| [05](docs/05-adding-2d-drawings.md) | Adding 2D — AutoCAD drawings with MSDF/SDF zoom scaling |

## Source

The complete source code for this demo is in this repository. The key files:

- [`main.mjs`](main.mjs) — MapLibre custom layer, camera sync, model loading
- [`lmv-loader.mjs`](lmv-loader.mjs) — LMV initialization, renderer injection, transparency patches
- [`index.html`](index.html) — Minimal UI with model picker
