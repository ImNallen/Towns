# Towns

A minimalist city builder with a deterministic traffic simulation.

```bash
pnpm install
pnpm exec playwright install chromium   # once, for screenshot tests
pnpm dev
```

Open the local address printed by Vite to play Meadow Vale. With **Road** selected, drag from a street end to extend it, or from the middle of a street to create a T-junction. Release on another street to connect. The preview shows the pavement and the space drivers need to turn.

Drag across an existing street to build a four-way intersection. You can start the drag on open ground. To turn a T into a four-way, start at its center and extend the side street through the junction. The existing through street keeps priority. Short dashed lines show where drivers yield. One **Undo** removes the full drag and restores the previous streets.

**Angle snap** is on by default. Drag near a right angle or a 45° diagonal to align a branch with the street under your pointer. On a curve, the angle follows the street at the point where you start. You can also extend a road end straight ahead or align a branch parallel to a nearby street. The preview marks the active guide. Drag away from it or turn off **Angle snap** to choose your own angle.

For a winding road, select **Curve**, drag from the start to the end, then place a point on the bend. Move the pointer to preview the curve and click to build. On a touch screen, press and move to adjust the bend before lifting your finger.

Cars travel between the two map entrances and follow the quickest available route by free-flow travel time. Connect the neighborhoods, then try building a shorter route while cars are moving. **Undo** removes the last section and restores the previous junctions. If a car still needs a removed section, new arrivals wait while traffic clears. Keep the simulation running to finish the edit or choose **Cancel edit**.

**R** selects Road, **C** selects Curve, **V** selects Pan, and **Escape** cancels a draft. Right-drag to pan and scroll to zoom.

**Space** pauses the simulation, **1–4** set speed, and **L** toggles the lane graph. The original traffic maps are available at `?scenario=roundabout` and `?scenario=straight`.

See [CLAUDE.md](CLAUDE.md) for architecture, rules and commands.
