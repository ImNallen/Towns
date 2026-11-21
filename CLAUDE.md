# Towns

A minimalist-looking city builder with a deep simulation. Top-down orthographic 3D in a flat, map-like style
(white roads with thin outlines, flat colours, soft drop shadows, terraced hills). Built mostly by AI agents, so
the rules below exist to keep the codebase verifiable.

## Commands

```bash
pnpm dev            # http://localhost:5173 (see URL params below)
pnpm check          # typecheck + unit tests. Run before saying anything is done.
pnpm test           # vitest: sim tests + architecture guard (fast, headless)
pnpm sim            # headless sim run, prints stats + state hash
pnpm sim --scenario straight --ticks 2400 --seed 7 --every 600
pnpm e2e            # Playwright: boots the app, saves screenshots to artifacts/screens/
```

URL params: `?scenario=meadow|roundabout|straight&seed=1&speed=0..8&lanes=1&zones=1&x=0&y=0&mpp=0.14`
(`x`,`y` = view centre in metres, `mpp` = metres per pixel; `lanes=1` shows the lane graph; `zones=1` shows the zone cells).

## Architecture

```
src/sim/        Pure, deterministic simulation. No DOM, no Three.js, no React, no wall clock.
  math/         Vec2, Polyline (arc-length paths as Float64Arrays), Bézier/arc sampling
  network/      Lane graph (lanes, next/prev, give-way) + drawable surfaces; NetworkBuilder validates it
  traffic/      IDM car-following, SoA vehicle storage, next-hop routing tables
  scenarios/    Map definitions (network + demand + scenery)
  zoning/       Zone cells beside every built road, and zone strokes painted onto them (Meadow Vale only;
                the World does not read them yet)
  world.ts      World: fixed 20 Hz tick (DT = 1/20), stats, snapshot, hash
src/worker/     Runs World in a Web Worker; protocol.ts defines every message
src/render/     Three.js: camera, road meshes, scenery, instanced vehicles, debug overlay, game loop
src/ui/         React HUD over the canvas
scripts/sim.ts  Headless runner
tests/          vitest (tests/**/*.test.ts) and Playwright (tests/e2e)
```

Data flow: `main.tsx` → `createGame` starts the worker → worker builds the scenario and `World`, posts `ready`
(the scenario, for drawing) and then a `frame` (positions, ids, stats) after each batch of ticks → the renderer
interpolates between the last two frames. On Meadow Vale the worker also owns the ordered list of edits: roads,
removals and zone strokes. The editor previews a placement with the same planner the worker uses to accept it.
A zone stroke never changes the network, so the worker applies it and its undo without rebuilding the World, and both
threads derive the painted cells with `meadowZoning(edits, cells)`. Each road edit rebuilds the local lane network and maps active vehicles to their positions and destinations. If a trip cannot continue safely, the worker pauses new arrivals and retries as traffic clears.

## Rules (enforced by tests/architecture.test.ts where possible)

1. **`src/sim` never imports** `three`, `react`, `src/render`, `src/ui`, `src/worker`, or touches `window`,
   `document`, `self`, `globalThis`.
2. **Determinism.** No `Math.random` (use `Rng`), no `Date`/`performance.now` in `src/sim`. Iterate in a stable
   order (slot index, lane id). Break sort ties by id. In per-tick code use only `+ - * /` and `Math.sqrt`
   (transcendental functions like `sin`, `atan2`, `hypot`, `pow` can differ between platforms). `World.hash()`
   must match for the same scenario and seed; there is a test for it.
3. **Data-oriented hot paths.** Per-vehicle state lives in typed arrays (`Vehicles`), not objects. No allocation
   inside `World.step()`.
4. **Fixed timestep.** The sim only advances in `DT` steps. Rendering never changes sim state; it interpolates.
5. **World coordinates**: metres, x = east, y = north. Three.js space is `(x, height, -y)`. Right-hand traffic;
   roundabouts run counter-clockwise.
6. **Every sim behaviour change gets a test** in `tests/sim/`: a scenario run with assertions on stats or
   invariants (no same-lane overlaps, `lost === 0`, no gridlock). Check `pnpm sim` numbers before and after.
7. **Every visual change gets looked at.** Run `pnpm e2e` and read the PNGs in `artifacts/screens/`.
   Add a screenshot to `tests/e2e/smoke.spec.ts` for anything new worth seeing.
8. Colours live in `src/render/palette.ts` only. Lighting is calibrated so flat up-facing surfaces render at
   exactly their palette colour; keep `AMBIENT + SUN·cosθ = π` if you touch lights (`src/render/game.ts`).
9. Anything that will need OS access later (saves, files) goes behind a small interface in `src/platform/`, so
   the desktop shell (Tauri or Electron) stays swappable.
10. Pin dependency versions exactly. Check the installed version's API (node_modules or docs) instead of
    trusting memory. Three.js changes between releases.

## Simulation model (current)

- **Lanes** are polylines with a speed limit and `next` lanes. Junctions are connector lanes.
  `NetworkBuilder.build()` throws if connected lanes do not touch or give-way rules are inconsistent.
- **Car following**: IDM (`traffic/idm.ts`), looking ahead up to 90 m along the vehicle's route, through lane ends.
  A car heading for a building slows to a turning speed (4 m/s) for its driveway; sinks are left at road speed.
- **Give way**: a lane with `yieldTo` stops at its end unless no priority vehicle arrives within a time window
  (`World.mergeBlocked`). Drivers within 1.5 m are committed, and cars on the priority road treat them as leaders.
- **Routing**: per-destination next-hop tables (reverse Dijkstra on free-flow time). Vehicles store only a
  destination index.
- **Demand**: Poisson arrivals per source lane, random reachable destination (no immediate U-turns).

## Roadmap (rough order)

1. Meadow Vale supports road extensions, deliberate curves, T-junctions, four-way crossings, live edits, and undo.
   The bulldozer removes individual segments and updates their junctions. Larger maps may need incremental routing.
2. Traffic lights for busy intersections.
3. Zoning + buildings as sim entities; trips generated from homes → jobs/shops instead of map edges.
4. Congestion-aware routing (costs from measured lane speeds, recomputed across several ticks).
5. Level of detail: aggregate flow for off-screen or distant areas.
6. Save/load (`src/platform`), then the desktop shell.
