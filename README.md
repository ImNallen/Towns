# Towns

A minimalist city builder with a deterministic traffic simulation.

```bash
pnpm install
pnpm exec playwright install chromium   # once, for screenshot tests
pnpm dev
```

Open the local address printed by Vite to play Meadow Vale. Drag from either marked street end to extend it. Release near the opposite marker to snap the streets together and start traffic in both directions. Follow the preview to build a gentle bend, or join the neighborhoods in one drag.

Choose **Pan** or right-drag to move the map. Scroll to zoom. **R** selects the road tool, **V** selects pan, **Escape** cancels a draft, and **Undo road** removes the last section. Undoing a completed connection clears its traffic so you can try a different route.

**Space** pauses the simulation, **1–4** set speed, and **L** toggles the lane graph. The original traffic maps are available at `?scenario=roundabout` and `?scenario=straight`.

See [CLAUDE.md](CLAUDE.md) for architecture, rules and commands.
