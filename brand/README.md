# SpindleCommerce brand

The Helix pack: the logo, symbol, wordmark and app icons as SVG, and `tokens.json` with the
colours, type, spacing and radii. They are copies from the SpindleCommerce design system, which
holds the brand book (voice, usage, clear space). Edit them there, then copy them here again.

| Folder | What | Used in |
|---|---|---|
| `logos/` | `spindle-commerce-*`: the full logo (the Helix, "spindle" and "commerce"), horizontal and stacked. `spindle-*`: the compact lockup without "commerce". `-light-bg` has ink lettering, `-dark-bg` white. `-black` and `-white` are single-ink, for one-colour print only. | The compact lockup in the admin (`admin/src/assets/brand/`) and the sample storefront (`storefront/public/brand/`), since at their sizes the full logo's "commerce" line is too small to read. |
| `symbols/` | The Helix on its own, for places too small for a logo. | |
| `wordmarks/` | The lettering without the Helix, orange i-dot kept. | |
| `icons/` | App tiles. `favicon.svg` is the approved favicon. | `admin/public/favicon.svg`, `storefront/app/icon.svg` |

Rules for code:

- Never recolour, stretch or re-type a mark: the lettering is artwork. Leave the i-dot's diameter
  clear on every side.
- Violet `#5b3ef4` leads, for primary buttons and key highlights, with white text. In dark themes,
  text and links use `#a594f0` instead, since violet on the dark surface is 3:1.
- Orange `#ff8b42` is a spark, not a fill: one highlight per view, with ink `#241948` text on it,
  never as text on light grounds.
- One family, Plus Jakarta Sans. No gradients or glows. Depth is a hairline and a soft shadow.
