# REVO Eclipse

`revo-eclipse.png` is the original background created for REVO's voice room, entry and room browser. It is served locally; no remote image service is required at runtime.

- Mode: new image generation with the built-in `image_gen` tool (imagegen skill).
- Output: `wwwroot/img/atmosphere/revo-eclipse.png`, 1672 × 941 PNG.
- UI, icons, typography, gradients and interaction states are implemented in HTML, CSS and SVG; they are not baked into the image.
- Animated accents for Eclipse and the alternative Silk wallpaper are rendered locally by `wwwroot/js/ambient-scene.js`. They are code-native Canvas graphics, with reduced-motion and visibility handling; no video download is required. Users can also select Plain or freeze wallpaper movement in Appearance settings.

## Generation prompt

Use case: stylized-concept. Asset type: premium desktop voice-chat application's room stage background, landscape 16:9. Create a beautifully art-directed AAA cinematic abstract black-hole eclipse, a massive perfectly dark obsidian sphere centered slightly right, thin luminous silver-white accretion ring viewed at a dramatic slight diagonal, delicate cold blue light scattering, extraordinarily fine cosmic dust in deep near-black space, subtle dark slate atmospheric haze. Sophisticated, restrained luxury sci-fi art direction, photographic physically rendered light, stunning microdetail at the bright edges. Palette overwhelmingly black, charcoal, ice white with extremely subtle cool lavender, no loud purple. Enough dark negative space across the left third and lower quarter for UI overlay. This is a finished raster background illustration for a real app, not a UI screenshot. No text, no lettering, no logos, no interface widgets, no people, no buildings, no watermarks. Wide composition, high resolution, elegant and quietly dramatic.
