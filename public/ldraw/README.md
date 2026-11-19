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
| `4915-1-MiniConstruction.mpd_Packed.mpd` | 4915-1 Mini Construction | Ken Drew |
| `4918-1-MiniFlyers.mpd_Packed.mpd` | 4918-1 Mini Flyers | Ken Drew |
| `1621-1-LunarMPVVehicle.mpd_Packed.mpd` | 1621-1 Lunar MPV Vehicle | Damien Roux |
| `5935-1-IslandHopper.mpd_Packed.mpd` | 5935-1 Island Hopper | Stan Isachenko |
| `6965-1-TIEIntercep_4h4MXk5.mpd_Packed.mpd` | 6965-1 TIE Interceptor (mini) | Evert-Jan Boer |
| `6966-1-JediStarfighter-Mini.mpd_Packed.mpd` | 6966-1 Jedi Starfighter (mini) | Evert-Jan Boer |
| `30051-1-X-wingFighter-Mini.mpd_Packed.mpd` | 30051-1 X-wing Fighter (mini) | Jude Parrill |
| `30054-1-AT-ST-Mini.mpd_Packed.mpd` | 30054-1 AT-ST (mini) | Jude Parrill |
| `4489-1-AT-AT-Mini.mpd_Packed.mpd` | 4489-1 AT-AT (mini) | Evert-Jan Boer |
| `4494-1-Imperial Shuttle-Mini.mpd_Packed.mpd` | 4494-1 Imperial Shuttle (mini) | Evert-Jan Boer |
| `7140-1-X-wingFighter.mpd_Packed.mpd` | 7140-1 X-wing Fighter | Daniel Goerner |
| `10174-1-ImperialAT-ST-UCS.mpd_Packed.mpd` | 10174-1 Imperial AT-ST (UCS) | Roland Dahl |

Star Wars sets are trademarks of Lucasfilm Ltd., which likewise does not
sponsor or endorse this project.

Part authors are credited in each part's header inside the packed files.

To add a set, pack it with three.js's `utils/packLDrawModel.mjs` against a full
LDraw library (https://library.ldraw.org/library/updates/complete.zip), drop
the result here and add it to `SETS` in `src/scene/ldrawSet.ts`.
