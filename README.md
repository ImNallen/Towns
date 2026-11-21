# Towns

Build streets and neighbourhoods in Meadow Vale. Residents choose where to work, how to get there, and where to shop. Your first job is to connect the two neighbourhoods.

```sh
pnpm install
pnpm dev
```

Open the local address printed by Vite. Select **Road** (`R`) and drag from one marked street end to the other. Watch the preview, then release to build. Select **Zone** (`Z`) and paint roadside plots. Homes and businesses grow as demand builds. Click a home or business to see who lives or works there.

## Map tools

| Tool or tray | How to use it |
| --- | --- |
| **Roads** | Drag a road or click successive points to chain segments. Branch from the side of a street for a T-junction or drag across it for a four-way. **Angle snap** helps line up the road. With **Curve** (`C`), drag between the ends, then click to set the bend. |
| **Road types** | With Road, Curve, or **Upgrade** (`U`) selected, press `5` for Country lane, `6` for Town street, `7` for Town street with parking, or `8` for a four-lane Avenue. With Upgrade, click an existing segment to change its type in place. |
| **Roads → Lights** (`J`) | Choose **Traffic actuated** or **Fixed time**, then click a T or four-way junction. Actuated lights keep the main road green until side-street traffic or a pedestrian needs a turn. |
| **People** | Drag a **Path** between pavements for a walking shortcut. Place a **Crossing** where walkers need priority across a street. Choose **Parking** and click empty frontage to build a lot with two, four, or six spaces. |
| **Land use** | With **Zone** active, choose Residential (`H`), Shops (`S`), Workplaces (`W`), or Erase (`E`). Erasing an occupied lot can demolish its building. Choose **Park**, pick a size, and click frontage to give residents a place to walk. |
| **Views** | **Traffic view** colours lanes by delay. **Parking occupancy** shows free bays in green and occupied bays in orange. **Lane graph** (`L`) shows the paths drivers can take. |

**Bulldoze** (`B`) removes the highlighted street segment. **Undo** (`Ctrl+Z` or `⌘Z`) reverses the last edit and its invoice. Check the placement price before building and open **Town budget** to see taxes and upkeep.

Right-drag to pan or select **Pan** (`V`). Scroll to zoom. `Esc` closes the open tray, cancels a draft, or finishes a road chain. `Space` pauses or resumes. Keys `1`, `2`, `3`, and `4` set 1×, 2×, 4×, and 8× speed.

For simulation commands, architecture, and contributor rules, see [CLAUDE.md](CLAUDE.md).
