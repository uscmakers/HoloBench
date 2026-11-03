# LDraw models

This software uses the [LDraw Parts Library](https://www.ldraw.org). LDraw is a
trademark of the Estate of James Jessiman. LEGO is a trademark of the LEGO
Group, which does not sponsor, authorize or endorse this project.

The models in `models/` come from the LDraw Official Model Repository, packed
with every part and color they use into one file each (taken from the
three.js r169 examples, `examples/models/ldraw/officialLibrary/models/`). Parts
and models are redistributable under the Creative Commons Attribution License
2.0 (CCAL 2.0).

| File | Set | Model author |
|---|---|---|
| `4838-1-MiniVehicles.mpd_Packed.mpd` | 4838-1 Mini Vehicles | Ken Drew |
| `889-1-RadarTruck.mpd_Packed.mpd` | 889-1 Radar Truck | Willy Tschager |
| `30023-1-Lighthouse.ldr_Packed.mpd` | 30023-1 Lighthouse | Merlijn Wissink |

Part authors are credited in each part's header inside the packed files.

To add a set, pack it with three.js's `utils/packLDrawModel.mjs` against a full
LDraw library (https://library.ldraw.org/library/updates/complete.zip), drop
the result here and add it to `SETS` in `src/scene/ldrawSet.ts`.
