# Architecture

Next.js App Router serves five navigable routes. React client-side components manage controls. Zustand persist saves small versioned JSON settings and presets; IndexedDB stores user-imported image Blobs. No backend service is called. Browser-side editors use a source-pixel coordinate system, mapped to a scaled Konva Stage. The mask PNG is painted into a separate original-size HTML canvas, preserving source data. The face selection produces JSON metadata.

Design system: AMBER CORE, dark background #0D0D0F, orange #FF9800 and gold #FFC247. CSS media queries provide bottom navigation under 900px and left sidebar above it. The original supplied identity graphic remains in `public/logo/y-original.png`.

`src/lib/engine/types.ts` defines the public adapter interface; `mock.ts` returns OFFLINE and rejects attempted jobs without fabricating progress or results. For real operation, implement an authenticated backend adapter and a server-side pairing service; never store secrets in this Zustand store.

Known limits: no live GPU API, no automated browser test infrastructure, no face recognition or ControlNet preprocessor, source images in generator/editor are ephemeral during navigation, exported presets do not include uploaded images. Gallery image storage is persistent per browser origin. The mask editor offers view pan arrows (not two-finger pan) with touch brush input. Mobile browsers may temporarily evict IndexedDB under storage pressure.
