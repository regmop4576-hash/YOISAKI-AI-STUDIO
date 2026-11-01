# Editor: Inpaint, Img2Img, Face Fix

All editor modes run on the connected GPU using the checkpoint and LoRA chosen on the Generate page. The source
image is never modified; results are saved to the gallery. PNG / JPG / WEBP up to 25 MB. Drafts (image, mask,
face box, mode, parameters) survive navigation and reloads; clear them in Settings → Editor.

## Inpaint

1. **Upload image**.
2. **Brush** paints the area to change (**white is edited, black is kept**); **Eraser** removes mask. Brush size is
   in source pixels. Zoom in/out, pan, reset view, undo/redo.
3. Describe the new content in the prompt; set **Strength** (denoise).
4. Advanced: Inpaint region — *mask area + context* (crop) or *whole source as context* (full); context padding;
   mask feather.
5. Run, then compare **Before / After**. Output keeps the source size and alpha. "Download mask PNG" exports the
   full-resolution mask (≤ 6 MB).

## Img2Img

Uses the whole image as a base. ~0.3 strength = light restyle, 0.6–0.8 = strong redraw keeping composition.

## Face Fix (engine 1.8.1)

1. Upload a portrait; faces are detected automatically (CPU detectors for anime and human faces).
2. One face is selected automatically; for several, tap one or use "Fix all detected faces (N), one by one".
3. **FIX FACE**, compare Before / After, then **Save result** or keep the original.

Faces of anthro characters, profiles and faces under ~30 px may be missed or low-confidence — select the face
manually by drawing around it. Low-confidence candidates are never auto-selected. Start with strength 0.25–0.30;
default profile (0.30, 25 steps, CFG 5.5) is a starting point not yet tuned on T4.

Editor modes need batch 1 and ControlNet / Regional Control turned off.
