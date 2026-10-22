# YOISAKI AI STUDIO v1.1.0

Updated from the original 1.0 source, not rebuilt.

## v1.1 changes
- Russian default and English setting; translation dictionary in `src/lib/i18n.ts` with a legacy-component localization bridge. Technical vocabulary remains recognizable.
- Improved handset layouts and compact pre-upload image editor.
- Removed all sample model records and cleared stale checkpoint / LoRA references on persisted state hydration.
- Preserved local gallery, settings and presets. Existing imported gallery images are not deleted.
- React Konva is constrained to `~19.2.0` to avoid incompatible later minor lines.

## Verification status
Static TypeScript/TSX syntax transpilation passed. `npm install --offline` FAILED because registry packages are not cached. Full TypeScript verification, build, and interactive browser tests were **NOT** completed. Verify before replacing a live deployment. No lockfile is included because dependency resolution was unavailable. The legacy-component localization bridge does not guarantee coverage of every dynamically generated string; audit remaining copy before release.

# YOISAKI AI STUDIO 1.1.0

AMBER CORE is a **frontend-only**, mobile-first AI image workspace built with Next.js App Router, React, TypeScript, Tailwind CSS, Zustand, Lucide React and React Konva. No AI inference or GPU authentication is implemented. The original provided Y emblem is stored at `public/logo/y-original.png`; its optimized derivative is used in navigation.

## Requirements

Node.js 20+ (22 recommended), npm, a modern browser with IndexedDB support.

```bash
npm install            # install dependencies and generate package-lock.json
npm run dev            # http://localhost:3000
npm run typecheck
npm run build
npm start              # serve production build
```

**Packaging limitation:** the build environment could not reach the npm registry, so a dependency lockfile could not be generated and dependency installation/build verification could not be completed here. Run `npm install` in a network-enabled environment, commit the resulting `package-lock.json`, then run typecheck and build. ESLint config is not bundled, so lint is not a validated command.

## Features available offline

- Generate: persistent positive/negative prompts, mode switch, editable settings and seeded configurations, model/LoRA selection demo, ControlNet input preparation, presets with JSON import/export.
- Edit: browser-local image import, brush/eraser mask painting, undo/redo, zoom and pan, full source-resolution black/white PNG mask export, manual face bounding box selection/resizing and metadata export.
- Models: filterable sample metadata with compatibility notices; no checkpoints are bundled.
- Gallery: user-imported images saved in IndexedDB; filtering, favorites, image details, local notes, downloads, deletion and metadata export.
- Engine: explicit OFFLINE state and planned secure pairing flow, with provider-agnostic TypeScript API contract.
- Settings: preferences and local export/reset operations.

**Unavailable:** GPU connection, actual inference, pose extraction, face auto-detection, AI job execution and generated image downloads. Never interpret demonstration entries as installed models.

## Manual GitHub upload

1. Create an empty repository in your GitHub account.
2. Unzip this package on your computer, or use GitHub's **Add file → Upload files** interface to add the project files (include hidden files like `.gitignore`).
3. Commit the files. Do not upload `node_modules`, `.next`, or secrets.

## Manual Vercel import

1. In Vercel, choose **Add New → Project → Import Git Repository**.
2. Select the repo you uploaded.
3. Keep **Framework Preset: Next.js**, **Root Directory: /**, **Install Command: npm install** until you have committed a generated lockfile (then use `npm ci`), and **Build Command: npm run build**.
4. Do not add environment variables for this frontend-only version.
5. Review the build output and deploy manually. This archive does **not** perform deployment.

## Test locally

Run `npm run typecheck` and `npm run build`, then open the local development site at mobile viewport sizes 320/360/390/430px, tablet 768px, and desktop 1024/1440px. Test local uploads, mask alignment/export, IndexedDB persistence, and settings import/export directly in the browser. See `docs/ARCHITECTURE.md`.

## Security and data

Settings and small presets live in browser localStorage. Imported pictures are saved as Blobs in IndexedDB and do not leave the browser. Data is tied to the browser, profile, and origin; clearing site data will delete it. Do not upload untrusted oversized files or put backend credentials in the frontend.

## v1.2 Connect (development-only)
Server API requires private DATABASE_URL, OWNER_PASSWORD, SESSION_SECRET. See ../docs/DEPLOYMENT_REQUIREMENTS.md. Inference not implemented.
