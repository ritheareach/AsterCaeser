# AsterCaeser product UI

**System:** Dark, operator-grade utility UI: monospaced metadata, hairline partitions, cyan for live information, and coral only for decisive actions.

```css
:root {
  --bg: oklch(14% 0.014 242);
  --surface: oklch(17% 0.015 242);
  --fg: oklch(85% 0.145 210);
  --muted: oklch(68% 0.025 230);
  --border: oklch(26% 0.028 230);
  --accent: oklch(65% 0.21 20);
}
```

- Use a nearly-black blue canvas with one raised surface tone.
- Set labels, timestamps, identifiers, and status metrics in a technical mono face.
- Use cyan for live data and focus; reserve coral for the main action or urgent intervention.
- Separate dense regions with 1px lines, not shadows or floating cards.
- Keep status compact and inline; avoid decorative imagery and large marketing headlines.
