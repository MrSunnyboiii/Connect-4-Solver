/*
=========================================
CONNECT 4

0 = Empty
1 = Red
2 = Yellow

This implementation includes:
- Local multiplayer on any board from 4x4 to 10x10
- Score persistence until refresh
- Ghost landing preview
- Animated falling tokens
- Win detection
- Exact solvers (per-column analysis + AI play) for:
    * 7x6 via the Pons-based solver (variants/7x6/wasm/Connect-4-Solvers.js)
    * every WIDTHxHEIGHT board with >= 4 columns, >= 4 rows, and <= 35
      cells via the c4 engine (variants/<W>x<H>/wasm/solver.js), built from
      https://github.com/ChristopheSteininger/c4
=========================================
*/

// AI mode: 0 = Off, 1 = AI plays Red, 2 = AI plays Yellow
let aiMode = 0;

let cachedScores = null;
let analyzeEnabled = false;

// Current board dimensions
let rows = 6;
let cols = 7;

// Current board state
let board = [];
let positionString = "";

// Current player
let currentPlayer = 1;

let gameOver = false;

// ---------- History ----------
let history = [];
let historyIndex = -1;

const boardElement = document.getElementById("board");
const turnIndicator = document.getElementById("turnIndicator");
const modal = document.getElementById("modal");
const winnerText = document.getElementById("winnerText");
const analysisText = document.getElementById("analysisText");
const positionInput = document.getElementById("positionInput");

/*
=========================================
Solver registry

Every supported board size maps to one solver entry. Solvers are loaded on
demand the first time their size is selected.

- "pons": the original 7x6 solver (Pascal Pons design) with its opening
  book. Synchronous per-column scores via Solver_7x6.bestMove().
- "c4": the c4 engine (one WASM module per board size, no opening book).
  Asynchronous single-position solves on worker threads.
=========================================
*/

// Every rectangular board with >= 4 columns, >= 4 rows, and <= 35 cells,
// in both orientations where both qualify (gravity makes them different
// games). Keys and directories are WIDTHxHEIGHT.
const C4_SIZES = [
    "4x4", "5x4", "6x4", "7x4", "8x4",
    "4x5", "5x5", "6x5", "7x5",
    "4x6", "5x6",
    "4x7", "5x7",
    "4x8",
];

const SOLVER_REGISTRY = new Map();

SOLVER_REGISTRY.set("7x6", { kind: "pons", key: "7x6", width: 7, height: 6 });

for(const key of C4_SIZES){
    const [width, height] = key.split("x").map(Number);

    SOLVER_REGISTRY.set(key, {
        kind: "c4",
        key,
        width,
        height,
        scriptUrl: `variants/${key}/wasm/solver.js`,
        factoryName: `createSolver${width}x${height}`,
    });
}

function sizeKey(){ return `${cols}x${rows}`; }
function solverEntry(){ return SOLVER_REGISTRY.get(sizeKey()) ?? null; }
function solverSupported(){ return solverEntry() !== null; }

// Set if the page failed to become cross-origin isolated; the c4 builds are
// multithreaded and need SharedArrayBuffer.
let coiError = null;

// ---------- Pons 7x6 solver ----------

const pons = { solver: null, loaded: false, loading: false, error: null };

async function initializePons(){
    if(pons.loaded || pons.loading) return;

    pons.loading = true;

    try {
        const { default: createModule } = await import("./variants/7x6/wasm/Connect-4-Solvers.js");
        const wasmModule = await createModule({
            // The module lives in variants/7x6/wasm/, so point every runtime
            // asset request (notably the opening book .data file) there.
            locateFile: (path) => new URL(`./variants/7x6/wasm/${path}`, import.meta.url).href,
        });

        pons.solver = new wasmModule.Solver_7x6();
        pons.loaded = true;
    } catch(error){
        pons.error = `7x6 solver failed to load: ${error?.message ?? error}`;
        console.error(error);
    }

    pons.loading = false;

    if(solverEntry()?.kind === "pons"){
        updateAnalysis();
        maybePlayAI();
    }
}

/*
=========================================
c4 engine adapter

One module per board size (cached after the first load), but at most one
active solver per page. All solves are serialized through a queue: the
engine handles one position at a time and replies through the module-scoped
`onSolverMessage` callback with
    {type:"solved", score, bestMove, movesLeft}
    {type:"won", score}        for positions that are already over
    {type:"cancelled"}

Replies are isolated per module instance (no cross-tab channel), and every
consumer re-checks that the game state still matches before using a reply,
so results that became stale after a board-size change, reset, history
navigation, position import, or AI mode change are discarded.
=========================================
*/

const c4Modules = new Map();     // sizeKey -> Promise<module>
const c4LoadErrors = new Map();  // sizeKey -> error message

// The active c4 session: at most one per page.
// {key, module, solver, position, syncedMoves, queue, activeJob, analyzingFor, retired, disposed}
let c4Session = null;

// Monotonic token which invalidates in-flight session activations.
let activationSeq = 0;

function injectScript(url){
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");

        script.src = url;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`failed to load ${url}`));

        document.head.appendChild(script);
    });
}

function loadC4Module(entry){
    if(!c4Modules.has(entry.key)){
        c4Modules.set(entry.key, (async () => {
            await injectScript(entry.scriptUrl);

            const factory = window[entry.factoryName];

            if(typeof factory !== "function"){
                throw new Error(`${entry.scriptUrl} did not define ${entry.factoryName}`);
            }

            const wasmModule = await factory();

            // Verify the module was really built for this board size.
            if(wasmModule.BOARD_WIDTH !== entry.width || wasmModule.BOARD_HEIGHT !== entry.height){
                throw new Error(
                    `module reports ${wasmModule.BOARD_WIDTH}x${wasmModule.BOARD_HEIGHT}, ` +
                    `expected ${entry.key}`);
            }

            return wasmModule;
        })());
    }

    return c4Modules.get(entry.key);
}

// Free the solver (and its transposition table) and position of a retired
// session. Only called once any in-flight search has finished or cancelled.
function disposeC4Session(session){
    if(session.disposed) return;
    session.disposed = true;

    try { session.solver.delete(); } catch(error){ console.warn(error); }
    try { session.position.delete(); } catch(error){ console.warn(error); }
}

// Stop using the current session. If a search is in flight it is cancelled
// and cleanup happens when its reply arrives; otherwise cleanup is immediate.
function retireC4Session(){
    const session = c4Session;
    if(!session) return;

    c4Session = null;
    session.retired = true;

    session.queue.forEach(job => job.resolve({ type: "cancelled" }));
    session.queue = [];

    if(session.activeJob){
        session.solver.cancel();
    } else {
        disposeC4Session(session);
    }
}

function handleC4Message(session, data){
    const job = session.activeJob;
    session.activeJob = null;

    if(job) job.resolve(data);

    if(session.retired){
        disposeC4Session(session);
        return;
    }

    pumpC4Queue(session);
}

function pumpC4Queue(session){
    if(session.retired || session.activeJob || !session.queue.length) return;

    session.activeJob = session.queue.shift();

    // Mirror the requested position into the solver's Position object.
    while(session.syncedMoves.length) session.position.unmove(session.syncedMoves.pop());

    for(const ch of session.activeJob.movesStr){
        const col = Number(ch);
        session.position.move(col);
        session.syncedMoves.push(col);
    }

    session.module.solve_async(session.solver, session.position);
}

function solveC4(movesStr){
    return new Promise(resolve => {
        const session = c4Session;

        if(!session || session.retired){
            resolve({ type: "cancelled" });
            return;
        }

        session.queue.push({ movesStr, resolve });
        pumpC4Queue(session);
    });
}

// Drop all pending work; called whenever the game position changes or the
// AI mode changes. The in-flight search (if any) resolves as cancelled.
function cancelC4Solves(){
    const session = c4Session;
    if(!session) return;

    session.queue.forEach(job => job.resolve({ type: "cancelled" }));
    session.queue = [];

    if(session.activeJob) session.solver.cancel();
}

// Make the active c4 session (if any) match the selected board size:
// retire the old solver and load + activate the right module on demand.
async function syncSolverSession(){
    const entry = solverEntry();

    if(!entry || entry.kind !== "c4"){
        retireC4Session();
        activationSeq++;

        if(entry?.kind === "pons") initializePons();
        return;
    }

    if(c4Session?.key === entry.key) return;

    retireC4Session();

    const token = ++activationSeq;
    let wasmModule;

    try {
        wasmModule = await loadC4Module(entry);
    } catch(error){
        console.error(error);
        c4LoadErrors.set(entry.key, `${entry.width}\u00d7${entry.height} solver failed to load: ${error?.message ?? error}`);

        if(token === activationSeq && solverEntry() === entry) updateAnalysis();
        return;
    }

    // The user may have changed size again while the module loaded.
    if(token !== activationSeq || solverEntry() !== entry) return;

    const session = {
        key: entry.key,
        module: wasmModule,
        solver: new wasmModule.Solver(),
        position: new wasmModule.Position(),
        syncedMoves: [],
        queue: [],
        activeJob: null,
        analyzingFor: null,
        retired: false,
        disposed: false,
    };

    wasmModule.onSolverMessage = (data) => handleC4Message(session, data);
    c4Session = session;

    updateAnalysis();
    maybePlayAI();
}

/*
The c4 engine returns a single score per solve (unlike the 7x6 solver's
per-column vector), so analysis solves each playable child position and
negates the result back to the current player's perspective. Scores land
in `cachedScores` with the same convention as the 7x6 strip: positive =
current player wins (bigger = sooner), 0 = draw, negative = loses,
-100 = full column — so the score strip and heatmap render identically.
*/
async function analyzeC4(){
    const entry = solverEntry();
    const session = c4Session;

    if(!session || !entry || session.key !== entry.key) return;

    const base = positionString;

    if(session.analyzingFor === base) return; // Already analyzing this position.
    session.analyzingFor = base;

    const scores = Array(cols).fill(null);
    const movesVia = Array(cols).fill(null);

    cachedScores = scores;

    analysisText.textContent = "Solving...";
    renderScoreStrip();

    for(let c = 0; c < cols; c++){
        if(lowestRow(c) === -1){
            scores[c] = -100; // Full column.
            continue;
        }

        const data = await solveC4(base + c);

        // Abort if the game moved on (or the solve was cancelled) while
        // this column was solving.
        const stale =
            data.type === "cancelled" ||
            positionString !== base ||
            !analyzeEnabled ||
            c4Session !== session ||
            solverEntry() !== entry;

        if(stale){
            if(session.analyzingFor === base) session.analyzingFor = null;

            // Re-evaluate: if analysis is still wanted for the current
            // position (e.g. the abort came from an AI mode change rather
            // than a new move), this restarts it with fresh state.
            queueMicrotask(updateAnalysis);
            return;
        }

        // Child scores are from the opponent's perspective: negate.
        scores[c] = -data.score;
        movesVia[c] = data.type === "won" ? 1 : data.movesLeft + 1;

        renderScoreStrip();

        const cell = boardElement.children[lowestRow(c) * cols + c];
        if(cell) applyHeat(cell, scores[c]);
    }

    session.analyzingFor = null;

    let best = -Infinity;
    let bestCol = -1;

    for(let c = 0; c < cols; c++){
        if(scores[c] !== -100 && scores[c] !== null && scores[c] > best){
            best = scores[c];
            bestCol = c;
        }
    }

    if(bestCol !== -1){
        analysisText.textContent = scoreToTextMoves(best, movesVia[bestCol]);
    }

    renderScoreStrip();
}

function scoreToTextMoves(score, movesVia){
    const player = currentPlayer === 1 ? "Red" : "Yellow";

    if(score === 0) return `${player} can Draw`;

    const result = score > 0 ? "Wins" : "Loses";

    return `${player} ${result} in ${movesVia} Move${movesVia === 1 ? "" : "s"}`;
}

// The AI plays the engine's best move once the async solve resolves.
async function playAIC4(){
    const entry = solverEntry();
    const session = c4Session;

    if(!session || !entry || session.key !== entry.key) return;

    const base = positionString;
    const data = await solveC4(base);

    if(data.type !== "solved") return;
    if(positionString !== base || c4Session !== session || gameOver) return;
    if(aiMode === 0 || currentPlayer !== aiMode) return;

    dropPiece(data.bestMove);
}

// ---------- Game ----------

function initBoard(){
    board = Array.from({ length: rows }, () => Array(cols).fill(0));

    currentPlayer = 1;
    gameOver = false;

    history = [];
    historyIndex = -1;
    positionString = "";

    document.querySelector("#historyTable tbody").innerHTML = "";

    cancelC4Solves();
    syncSolverSession();
    updateTurn();
    renderBoard();
    updateAnalysis();
    updateAIButton();
    updateAnalyzeButton();
    maybePlayAI();
}

function resizeBoard(){
    // Fit the board inside its container and the viewport on any device.
    const wrapWidth = boardElement.parentElement.clientWidth || window.innerWidth;
    const maxWidth = Math.min(wrapWidth, 760);
    const maxHeight = Math.min(window.innerHeight * 0.62, 620);

    const ratio = cols / rows;

    let width = Math.min(maxHeight * ratio, maxWidth);
    let height = width / ratio;

    if(height > maxHeight){
        height = maxHeight;
        width = height * ratio;
    }

    boardElement.style.width = `${width}px`;
    boardElement.style.height = `${height}px`;

    const scoreStrip = document.getElementById("scoreStrip");
    const boardStyles = getComputedStyle(boardElement);

    scoreStrip.style.width = `${width}px`;
    scoreStrip.style.columnGap = boardStyles.columnGap;
    scoreStrip.style.paddingLeft = boardStyles.paddingLeft;
    scoreStrip.style.paddingRight = boardStyles.paddingRight;
}

function renderBoard(){
    resizeBoard();

    boardElement.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    boardElement.style.gridTemplateRows = `repeat(${rows},1fr)`;
    boardElement.innerHTML = "";

    for(let r = 0; r < rows; r++){
        for(let c = 0; c < cols; c++){

            const cell = document.createElement("div");
            cell.className = "cell";
            cell.dataset.row = r;
            cell.dataset.col = c;

            cell.addEventListener("click", () => dropPiece(c));
            cell.addEventListener("mouseenter", () => showGhost(c));
            cell.addEventListener("mouseleave", clearGhost);

            if(board[r][c] !== 0){
                const token = document.createElement("div");
                token.className = "token show " + (board[r][c] === 1 ? "red" : "yellow");
                cell.appendChild(token);
            }

            boardElement.appendChild(cell);

            // cachedScores carries the analysis of every solver, so this
            // heat loop covers the 7x6 and all c4 boards alike.
            if(analyzeEnabled && cachedScores && r === lowestRow(c)){
                applyHeat(cell, cachedScores[c]);
            }
        }
    }
}

function applyHeat(cell, score){
    if(score == null || score === -100) return;

    cell.style.boxShadow = `0 0 20px ${scoreColor(score)}`;
    cell.style.borderColor = scoreColor(score);
}

function updateTurn(){
    turnIndicator.innerHTML = currentPlayer === 1 ? "🔴 Red's Turn" : "🟡 Yellow's Turn";
}

function lowestRow(col){
    for(let r = rows - 1; r >= 0; r--){
        if(board[r][col] === 0) return r;
    }
    return -1;
}

function dropPiece(col){
    if(gameOver) return;

    const row = lowestRow(col);
    if(row === -1) return; // Full column

    cancelC4Solves();

    board[row][col] = currentPlayer;
    positionString += col.toString();

    saveHistory(col);
    renderBoard();

    if(checkWinner(row, col, currentPlayer)){
        gameOver = true;
        winnerText.innerHTML = currentPlayer === 1 ? "🔴 Red Wins!" : "🟡 Yellow Wins!";
        setTimeout(() => { modal.classList.add("show"); }, 350);
        return;
    }

    if(board.flat().every(v => v !== 0)){
        gameOver = true;
        winnerText.innerHTML = "🤝 Draw!";
        setTimeout(() => { modal.classList.add("show"); }, 350);
        return;
    }

    currentPlayer = currentPlayer === 1 ? 2 : 1;

    updateTurn();
    maybePlayAI();
    updateAnalysis();
}

function countDirection(row, col, dr, dc, player){
    let count = 0;
    let r = row + dr;
    let c = col + dc;

    while(r >= 0 && r < rows && c >= 0 && c < cols && board[r][c] === player){
        count++;
        r += dr;
        c += dc;
    }

    return count;
}

function checkWinner(row, col, player){
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];

    for(const [dr, dc] of dirs){
        const total =
            1 +
            countDirection(row, col, dr, dc, player) +
            countDirection(row, col, -dr, -dc, player);

        if(total >= 4) return true;
    }

    return false;
}

function saveHistory(col){
    history = history.slice(0, historyIndex + 1);

    history.push({
        board: board.map(r => [...r]),
        positionString,
        player: currentPlayer,
        col,
        move: history.length
    });

    historyIndex++;
    updateHistoryTable();
}

const rowsSlider = document.getElementById("rowsSlider");
const colsSlider = document.getElementById("colsSlider");

rowsSlider.addEventListener("input", () => { rows = Number(rowsSlider.value); });
colsSlider.addEventListener("input", () => { cols = Number(colsSlider.value); });

rowsSlider.addEventListener("change", initBoard);
colsSlider.addEventListener("change", initBoard);

/*
Ghost preview
Shows where the piece will land.
*/
function clearGhost(){
    document.querySelectorAll(".ghost").forEach(g => g.remove());
}

function showGhost(col){
    if(gameOver) return;

    clearGhost();

    const row = lowestRow(col);
    if(row === -1) return;

    const cell = boardElement.children[row * cols + col];

    const ghost = document.createElement("div");
    ghost.className = "token ghost " + (currentPlayer === 1 ? "red" : "yellow");

    cell.appendChild(ghost);
}

function applyPosition(sequence){
    positionInput.value = "";
    positionString = "";

    initBoard();

    let valid = true;

    for(const ch of sequence){
        const col = Number(ch);

        if(Number.isNaN(col) || col < 0 || col >= cols){
            valid = false;
            continue;
        }

        const row = lowestRow(col);

        if(row === -1){
            valid = false;
            continue;
        }

        board[row][col] = currentPlayer;
        positionString += col;

        saveHistory(col);

        currentPlayer = currentPlayer === 1 ? 2 : 1;
    }

    flashInput(valid);
    renderBoard();
    updateTurn();
    updateAnalysis();
    maybePlayAI();
}

function updateHistoryTable(){
    const tbody = document.querySelector("#historyTable tbody");

    tbody.innerHTML = "";

    history.forEach((item, index) => {
        tbody.insertAdjacentHTML(
            "beforeend",
            `<tr data-index="${index}">
                <td>${item.move + 1}</td>
                <td>${item.col}</td>
                <td>${item.player === 1 ? "🔴" : "🟡"}</td>
            </tr>`
        );
    });
}

function flashInput(success){
    positionInput.classList.remove("flash-success", "flash-error");
    positionInput.classList.add(success ? "flash-success" : "flash-error");

    setTimeout(() => {
        positionInput.classList.remove("flash-success", "flash-error");
    }, 450);
}

// Score display for the 7x6 solver, whose scores use the classic 42-cell
// convention.
function scoreToText(score){
    const player = currentPlayer === 1 ? "Red" : "Yellow";

    if(score === 0) return `${player} can Draw`;
    if(score === -100) return `${player} Loses in 1 Move`;

    if(score > 0){
        const moves = 42 + currentPlayer - 2 * score - positionString.length;
        return `${player} Wins in ${moves} Move${moves === 1 ? "" : "s"}`;
    }

    const moves = 45 - currentPlayer + 2 * score - positionString.length;
    return `${player} Loses in ${moves} Move${moves === 1 ? "" : "s"}`;
}

function updateAnalysis(){
    const entry = solverEntry();

    if(!entry){
        cachedScores = null;
        renderScoreStrip();
        analysisText.textContent = "";
        return;
    }

    if(entry.kind === "c4"){
        const error = c4LoadErrors.get(entry.key) ?? coiError;

        if(!c4Session || c4Session.key !== entry.key){
            cachedScores = null;
            renderScoreStrip();
            analysisText.textContent = error ?? `Loading ${entry.width}\u00d7${entry.height} solver...`;
            return;
        }

        if(gameOver || !analyzeEnabled){
            cachedScores = null;
            renderScoreStrip();
            analysisText.textContent = "";
            return;
        }

        // Skip analysis while the AI is about to move; the position is
        // analyzed again right after its move.
        if(aiMode !== 0 && currentPlayer === aiMode){
            cachedScores = null;
            renderScoreStrip();
            analysisText.textContent = "Solving...";
            return;
        }

        analyzeC4();
        return;
    }

    // Pons 7x6 solver.
    if(!pons.loaded){
        cachedScores = null;
        analysisText.textContent = pons.error ?? "";

        renderScoreStrip();

        if(analyzeEnabled) renderBoard();

        return;
    }

    updateSolverScores();

    if(analyzeEnabled){
        renderScoreStrip();

        let best = -Infinity;

        for(let i = 0; i < cachedScores.length; i++){
            best = Math.max(best, cachedScores[i]);
        }
        analysisText.textContent = scoreToText(best);
    } else {
        renderScoreStrip();
        analysisText.textContent = "";
    }
    renderBoard();
}

const aiButton = document.getElementById("aiToggle");
const aiOptions = Array.from(aiButton.querySelectorAll(".ai-option"));

function updateAIButton(){
    if(!solverSupported()){
        aiButton.setAttribute("aria-disabled", "true");
        aiButton.disabled = true;
        aiButton.title = "AI requires a board size with a solver.";

        aiOptions.forEach(option => {
            option.disabled = true;
            option.classList.remove("active");
            option.setAttribute("aria-pressed", "false");
        });

        return;
    }

    aiButton.removeAttribute("aria-disabled");
    aiButton.disabled = false;
    aiButton.title = "";

    aiOptions.forEach(option => {
        const isActive = Number(option.dataset.mode) === aiMode;

        option.disabled = false;
        option.classList.toggle("active", isActive);
        option.setAttribute("aria-pressed", String(isActive));
    });

    maybePlayAI();
}

const analyzeButton = document.getElementById("analyzeToggle");

function updateAnalyzeButton(){
    if(!solverSupported()){
        analyzeButton.disabled = true;
        analyzeEnabled = false;
        analyzeButton.title = "Analysis requires a board size with a solver.";

        updateAnalysis();
        return;
    }

    analyzeButton.disabled = false;
    analyzeButton.title = "";
}

aiButton.addEventListener("click", (event) => {
    const option = event.target.closest(".ai-option");

    if(!option || !solverSupported()) return;

    aiMode = Number(option.dataset.mode);

    // Replies to solves started under the old AI mode are stale now.
    cancelC4Solves();

    updateAIButton();
    updateAnalysis();
});

function maybePlayAI(){
    if(aiMode === 0) return;
    if(currentPlayer !== aiMode) return;
    if(gameOver) return;

    const entry = solverEntry();
    if(!entry) return;

    // The c4 engine is async: the move is played when the result arrives.
    if(entry.kind === "c4"){
        if(c4Session?.key === entry.key) playAIC4();
        return;
    }

    if(!pons.loaded) return;

    updateSolverScores();

    let best = -Infinity;

    cachedScores.forEach(v => {
        if(v > best) best = v;
    });

    const choices = [];

    cachedScores.forEach((v, i) => {
        if(v === best) choices.push(i);
    });

    if(!choices.length) return;

    const move = choices[Math.floor(Math.random() * choices.length)];

    if(!gameOver) dropPiece(move);
}

function renderScoreStrip(){
    const strip = document.getElementById("scoreStrip");

    strip.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    strip.innerHTML = "";

    if(!analyzeEnabled || !cachedScores) return;

    // null entries are columns the c4 analysis has not solved yet.
    const resolved = cachedScores.filter(v => v !== null);
    const best = resolved.length ? Math.max(...resolved) : null;

    cachedScores.forEach(score => {
        const div = document.createElement("div");

        if(score === null){
            div.className = "score-value";
            div.textContent = "…";
        }else{
            div.className = score === best ? "score-value best" : "score-value";
            div.textContent = score === -100 ? "X" : score;
            div.style.color = scoreColor(score);
        }

        strip.appendChild(div);
    });
}

function scoreColor(score){
    if(score === -100) return "rgba(255,255,255,.15)";

    const minScore = -18;
    const maxScore = 18;

    score = Math.max(minScore, Math.min(maxScore, score));

    if(score === 0) return "hsl(52 100% 58%)";

    if(score < 0){
        const t = (score - minScore) / (-1 - minScore);
        const lightness = 38 + t * 24;
        const saturation = 88 - t * 8;
        return `hsl(0 ${saturation}% ${lightness}%)`;
    }

    const t = (score - 1) / (maxScore - 1);
    const lightness = 68 - t * 28;
    const saturation = 62 + t * 28;
    return `hsl(135 ${saturation}% ${lightness}%)`;
}

function updateSolverScores(){
    if(!pons.loaded){
        cachedScores = null;
        return;
    }

    const result = pons.solver.bestMove(positionString);

    cachedScores = [];

    for(let i = 0; i < result.size(); i++){
        cachedScores.push(result.get(i));
    }

    result.delete?.();
}

document.getElementById("playAgain").addEventListener("click", () => {
    modal.classList.remove("show");
    initBoard();
});

document.querySelector("#historyTable tbody").addEventListener("click", (e) => {
    const row = e.target.closest("tr");
    if(!row) return;

    const index = Number(row.dataset.index);
    const state = history[index];

    historyIndex = index;

    cancelC4Solves();

    board = state.board.map(r => [...r]);
    positionString = state.positionString;
    currentPlayer = 3 - state.player;

    updateAnalysis();
    renderBoard();
    updateTurn();
    maybePlayAI();
});

document.getElementById("resetBtn").addEventListener("click", initBoard);

document.querySelector(".tab-header").addEventListener("click", (e) => {
    const button = e.target.closest(".tab");
    if(!button) return;

    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    button.classList.add("active");

    document.querySelectorAll(".tab-view").forEach(v => v.classList.remove("active"));
    document.getElementById(button.dataset.tab).classList.add("active");
});

positionInput.addEventListener("keydown", (event) => {
    if(event.key !== "Enter") return;

    applyPosition(positionInput.value.trim());
});

analyzeButton.addEventListener("click", () => {
    if(analyzeButton.disabled) return;

    analyzeEnabled = !analyzeEnabled;

    updateAnalysis();
    renderBoard();
});

document.getElementById("copyPosition").addEventListener("click", async () => {
    await navigator.clipboard.writeText(positionString);

    const button = document.getElementById("copyPosition");

    button.textContent = "Copied!";

    setTimeout(() => { button.textContent = "Copy Position"; }, 1200);
});

// The multithreaded c4 builds need SharedArrayBuffer. If coi-serviceworker
// could not enable cross-origin isolation (e.g. the page was opened from
// file:// or the service worker was blocked), say so instead of failing
// silently.
window.addEventListener("load", () => {
    setTimeout(() => {
        if(!window.crossOriginIsolated){
            coiError =
                "Solver unavailable: page is not cross-origin isolated. " +
                "Serve this folder over HTTP and reload.";

            if(solverEntry()?.kind === "c4" && !c4Session) updateAnalysis();
        }
    }, 3000);
});

// Keep the board sized correctly when the window or orientation changes.
window.addEventListener("resize", resizeBoard);

// Debug/testing hook: a read-only view of the solver state.
window.__c4debug = () => ({
    sizeKey: sizeKey(),
    session: c4Session && {
        key: c4Session.key,
        queueLength: c4Session.queue.length,
        hasActiveJob: !!c4Session.activeJob,
        analyzingFor: c4Session.analyzingFor,
        retired: c4Session.retired,
    },
    aiMode,
    analyzeEnabled,
    positionString,
});

initBoard();
