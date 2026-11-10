# Connect-4-Solver

Implementing a Negamax Algorithm with Various Optimizations to Solve Multi-Dimensional Connect 4 Boards.
Compiled to WebAssembly for Compatability with User Interface ([Preview](https://mrsunnyboiii.github.io/Connect-4-Solver/)):

<img width="1000" height="600" alt="Screenshot 2026-10-06 at 7 40 48 PM" src="https://github.com/user-attachments/assets/5530050d-178a-4463-a680-1365aacc640d" />

## Supported boards

The homepage offers local two-player play on any board from 4×4 to 10×10.
Exact solving (AI play + per-column analysis) is available for:

* **7×6** — the original solver (Pascal Pons design) with its opening book.
* **Every rectangular board with ≥ 4 columns, ≥ 4 rows, and ≤ 35 cells**,
  solved by [c4](https://github.com/ChristopheSteininger/c4)
  (built from the fork [MrSunnyboiii/c4](https://github.com/MrSunnyboiii/c4)):

  | Height (rows) | Widths (columns) |
  |---------------|------------------|
  | 4             | 4, 5, 6, 7, 8    |
  | 5             | 4, 5, 6, 7       |
  | 6             | 4, 5             |
  | 7             | 4, 5             |
  | 8             | 4                |

  That is 14 variants. Both orientations are built where both qualify
  (e.g. 4×8 and 8×4) because gravity makes them different games. All 14
  builds are strong solvers (they report the move the game ends on) and
  ship **without** opening books — no `solver.data` file is requested.

## Layout

```
index.html                 Homepage: board, size sliders, AI, analysis
app.js                     Shared game logic, solver registry, c4 adapter
styles.css                 Shared homepage styles
coi-serviceworker.js       Cross-origin isolation shim. Must stay at the
                           project root so its scope covers every page.
variants/
  7x6/wasm/                Pons-based 7x6 solver (Connect-4-Solvers.js/.wasm/.data)
  <width>x<height>/wasm/   One c4 build per size (solver.js + solver.wasm),
                           module factory createSolver<width>x<height>
  7x5/                     Standalone 7x5 page (index.html, ui.js, styles.css)
```

All asset URLs are project-relative, so the site deploys as static files
under the GitHub Pages project path (`/Connect-4-Solver/`). The c4 builds
are multithreaded and need `SharedArrayBuffer`; `coi-serviceworker.js`
provides the COOP/COEP headers GitHub Pages cannot send.

## Reproducing the c4 WASM builds

The 14 `variants/<width>x<height>/wasm/` folders are built from the
[MrSunnyboiii/c4](https://github.com/MrSunnyboiii/c4) fork of
[ChristopheSteininger/c4](https://github.com/ChristopheSteininger/c4)
(branch `multi-size-wasm-variants` until merged). With an activated
[emsdk](https://github.com/emscripten-core/emsdk):

```sh
git clone https://github.com/MrSunnyboiii/c4.git
cd c4
source /path/to/emsdk/emsdk_env.sh
./scripts/build-wasm-variants.sh /path/to/Connect-4-Solver/variants
```

The script builds every supported size into
`<output-root>/<width>x<height>/wasm/`. Each build passes
`-DBOARD_WIDTH -DBOARD_HEIGHT` (one source tree, size fixed at compile
time), keeps strong solving enabled, uses the browser-safe memory
settings (64 MB transposition table in 128 MB of initial memory, one
search thread), and scopes the module factory as
`createSolver<width>x<height>` so several sizes can be loaded by one page.

To rebuild a single size:

```sh
./scripts/build-wasm-variants.sh /path/to/Connect-4-Solver/variants 7x5
```

## Adding a board size

1. Add the size to `ALL_SIZES` in `scripts/build-wasm-variants.sh` (c4 repo)
   and run the script — note the ≤ 35 cell limit is a practical solve-time
   limit, not an engine limit; bigger boards solve slowly in the browser.
2. Copy the generated `<width>x<height>/wasm/` folder into `variants/`.
3. Add the size to `C4_SIZES` in `app.js`. The registry, loader, AI, and
   analysis pick it up automatically.
4. If the size is outside the sliders' 4–10 range, widen them in
   `index.html`.

## Testing locally

The page must be served over HTTP (not `file://`) for the service worker
and `SharedArrayBuffer` to work, with the repository mounted under the
GitHub Pages project path:

```sh
cd ..   # parent of the repository checkout
python3 -m http.server 8000
# open http://localhost:8000/Connect-4-Solver/
```

## License

The 7×6 solver derives from Pascal Pons's
[connect4](https://github.com/PascalPons/connect4) solver and the c4
variants are built from
[ChristopheSteininger/c4](https://github.com/ChristopheSteininger/c4);
both are licensed under AGPL-3.0, and the corresponding source for the
deployed WASM binaries is available from the repositories linked above.
