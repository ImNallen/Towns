# Towns

Towns is a top-down city builder with a flat, orthographic 3D map. Meadow Vale and North Valley are editable towns. North Valley has a 2 km × 2 km map with three entrances and a starter road on the west edge. Mill Street, Roundabout, and Straight are traffic scenarios.

## Commands

```sh
pnpm install
pnpm dev                  # Vite prints the play URL
pnpm check                # typecheck and Vitest, required before completion
pnpm test                 # unit and architecture tests (test:watch for watch mode)
pnpm build                # typecheck and build for production
pnpm preview              # serve the production build
pnpm sim                  # Roundabout, seed 1, 12,000 ticks, final stats and hash
pnpm sim --scenario meadow --connect --paint mixed --ticks 288000 --every 28800
pnpm exec playwright install chromium
pnpm e2e                  # Playwright writes PNGs to artifacts/screens/
```

The Meadow example joins the neighbourhoods, paints homes, shops, and workplaces, and reports once per town day. Use bare `--paint` for homes only, `--seed N` to set the seed, or `--json` for a machine-readable final summary. On Meadow, `--zebra x,y` places a crossing. With paint, `--parking-lot CELL` reserves three frontage cells and `--park CELL --park-size 2` places a square park. Sizes are 1, 2, or 3.

Run studies with `pnpm exec tsx scripts/<name>.ts`.

| Script | What it measures |
| --- | --- |
| `town-study` | Happiness and growth across three mixed-zone layouts from `town-layout.ts` |
| `traffic-study` | Measured versus free-flow routing on Mill Street |
| `junction-comparison` | Queues, delay, and throughput under give-way, fixed, and actuated control. Add `--peak` for heavier demand. |
| `avenue-comparison` | Lane use on an Avenue approach and traffic in mixed-zone Meadow |
| `grow` | Builds a North Valley town and reports simulation costs, memory, frame bytes and hashes near 150, 500 and 1,000 homes. |
| `valley-browser` | Measures live FPS and worker ticks/s at the same milestones. Start `pnpm dev --port 5198` first. |
| `walker-benchmark` | Time per update for 300 moving walkers |

Browser options live in `src/main.tsx`. Use `?scenario=meadow` (also `valley`, `mill`, `roundabout`, or `straight`), `seed=1`, and `speed=1` (0 pauses). Combine parameters with `&`. Use `lanes=1` for the lane graph, `zones=1` for the zoning grid, and `walkLimit` for the base walking range in metres (default 600). Set `mpp` (metres per pixel) to enable the initial camera override with centre `x` and `y` in metres. Open `?catalogue=1` to browse buildings, road cross-sections, and vehicles.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/sim/world.ts`, `rng.ts` | World advances at 20 Hz, owns simulation state, remaps trips after edits, and computes stats and the state hash. Rng supplies seeded randomness. |
| `src/sim/math/`, `network/` | Geometry and arc-length paths. The network builds street cross-sections, connector lanes, junctions, signals, pavement graphs, and walking routes. |
| `src/sim/traffic/` | Typed vehicle arrays, Intelligent Driver Model (IDM), pedestrian conflicts, lane choice, measured traffic conditions, and next-hop routing. |
| `src/sim/scenarios/`, `zoning/` | Maps and demand. Meadow Vale and North Valley share the editable-map planner. Zoning identifies roadside cells, applies paint, and fits building lots. |
| `src/sim/town/` | Households, jobs, trips, mode choice, growth, parking, parks, happiness, edit invoices, and the town treasury. |
| `src/buildings/`, `src/vehicles/` | Shared building blueprints and deterministic design and finish selection. Vehicle catalogue with dimensions and driving characteristics. |
| `src/worker/` | Simulation worker and typed message protocol. |
| `src/render/`, `src/ui/` | Three.js map, editor previews, instanced vehicles and walkers. React tools, inspectors, budget, and catalogue. |
| `tests/sim/`, `tests/e2e/` | Headless behaviour tests and browser tests. Import and determinism guards live in `tests/architecture.test.ts`. |

`main.tsx` calls `createGame`. The worker builds the scenario and World, sends `ready` for the initial map, then publishes frames after batches of fixed ticks. The renderer interpolates positions. Town messages supply household, business, demand, and budget data for the HUD.

The editor and worker share placement planners. The worker checks funds and owns each town’s ordered edit history. A road edit builds a candidate network and projects vehicles onto reachable lanes. If a vehicle loses its route or safe spacing, the worker holds new arrivals and retries. Walkers transfer to reachable pavements or return home and increment `walkersCleared`. Both threads derive paint from live cell keys and the edit history. Painting or undoing a stroke updates zoning in place.

## Rules (enforced by tests/architecture.test.ts where possible)

1. **`src/sim` never imports** `three`, `react`, `src/render`, `src/ui`, `src/worker`, `src/platform`, or touches `window`,
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
   exactly their palette colour; keep `AMBIENT + SUN·cosθ = π` if you touch lights (`src/render/lighting.ts`, applied in `src/render/game.ts`).
9. Anything that will need OS access later (saves, files) goes behind a small interface in `src/platform/`, so
   the desktop shell (Tauri or Electron) stays swappable.
10. Pin dependency versions exactly. Check the installed version's API (node_modules or docs) instead of
    trusting memory. Three.js changes between releases.

## Simulation model

- **Streets.** Country lanes have one lane each way and bare verges. Town streets add pavements. Town streets with parking add kerbside bays and a lower speed limit. Avenues have pavements and two lanes each way. Upgrades replace a segment in place. Its cross-section sets speed, frontage offset, construction cost, and upkeep.
- **Junctions.** Lanes are directed polylines with a speed limit and links to adjacent lanes. Connector lanes encode turns and conflicts. On an Avenue, left turns use the inner lane and right turns use the outer lane. Through drivers choose the less occupied eligible lane before entry and stay in it along the link. Give-way approaches check conflicting traffic. Signals at T and four-way junctions use a fixed cycle or rest on main-road green until a side-street driver or pedestrian calls.
- **Driving and routing.** IDM looks up to 90 m along the route for leaders, including across lane ends. Vehicle models set length, acceleration, braking, and top speed. Reverse Dijkstra computes next hops per destination. Smoothed lane delays adjust free-flow costs. The sim refreshes one destination at a time and retains established turns for small cost differences. The traffic overlay shows delay by direction.
- **Trips.** Through traffic arrives at source lanes. Residents work locally or off-map, shop for groceries, and visit parks on foot. Walking uses pavement links, crossings, and player-built footpaths. Walkers wait for gaps at ordinary crossings, claim priority at zebras, and enter on parallel green at lights.
- **Parking and freight.** A local driving trip can include a walk to the car, a drive, and a walk from a bay to the door. Drivers try destination bays, then nearby parking up to 250 m away (65 m for groceries). A driver can circle once and return home after a refusal. Business deliveries use vans or lorries and wait for shared loading access.
- **Growth.** Painted frontage supplies vacant lots. Housing demand reflects jobs and vacancies, workplace demand reflects available labour, and shop demand reflects population and shop supply. Each use accumulates demand toward its next building. Households earn wages, buy groceries, cover daily costs, and can upgrade their home or car.
- **Happiness and money.** Needs, commute time, traffic delay and noise, parking refusals, and walkable shops and parks affect satisfaction. Satisfaction affects upgrades and housing growth. Persistent unhappiness can empty a zoned home. The town charges construction at placement and reverses the invoice on undo. At day close it settles home, shop, and workplace taxes against infrastructure upkeep.

## Roadmap

1. Consolidate the systems tuned on Meadow Vale. Use North Valley for scale tests and the Saves tray for replay checks, then playtest and balance.
2. Polish the game and add progression. New towns start small with a light tutorial. Population, happiness, budget, and solving traffic jams unlock tools at milestones. Sandbox mode starts with every tool unlocked.
3. Add medium-density buildings and highrises, then public transport.
