// ===============================
// ===============================
// RECOMMENDATION ENGINE
// ===============================
// Returns { cardId, miles, ruleType, ruleLabel, breakdown }
let userCardOverride = false;

// Miles earned when `alloc` dollars are spent on a card whose matched rule
// already has `used` dollars against its cap. Same math for all callers.
function computeEarn(card, rule, alloc, used) {
    const remaining = Math.max(0, rule.cap - used);
    const spend = Math.min(remaining, alloc);
    const spendAt0 = alloc - spend;
    const baseMpd = card.baseMpd || 0;
    let bonus, base;
    if (card.rounding === "block") {
        bonus = Math.floor(spend / card.blockSize) * card.blockSize * rule.mpd;
        base = Math.floor(spendAt0 / card.blockSize) * card.blockSize * baseMpd;
    } else {
        bonus = spend * rule.mpd;
        base = spendAt0 * baseMpd;
    }
    return {
        bonus,
        base,
        miles: Math.round((bonus + base) * 100) / 100,
        remaining
    };
}

function getBestCardForSpend(amount, type) {
    let best = null;
    const state = loadState();
    cards.forEach(card => {
        const { rule, ruleIdx } = findRuleForType(card, type);
        if (!rule) return;
        const used = getUsedAmountForRule(state, card, rule, ruleIdx);
        const earn = computeEarn(card, rule, amount, used);
        if (!best || earn.miles > best.miles) {
            best = {
                cardId: card.id,
                miles: earn.miles,
                ruleType: rule.type,
                ruleLabel: labelForRule(rule),
                breakdown: { bonus: earn.bonus, base: earn.base },
                remaining: earn.remaining
            };
        }
    });
    return best;
}

// Overflow split (opt-in): when the purchase exceeds the best card's
// remaining bonus quota, allocate spend across cards, highest mpd first.
// Block-earning cards only take whole blocks; any spend beyond every
// card's quota lands on the involved card with the best base rate.
function getSplitPlanForSpend(amount, type) {
    const state = loadState();
    const opts = [];
    cards.forEach(card => {
        const { rule, ruleIdx } = findRuleForType(card, type);
        if (!rule) return;
        const used = getUsedAmountForRule(state, card, rule, ruleIdx);
        opts.push({ card, rule, used, remaining: Math.max(0, rule.cap - used) });
    });
    if (opts.length < 2) return null;
    opts.sort((a, b) => b.rule.mpd - a.rule.mpd);

    const cents = (n) => Math.round(n * 100) / 100;
    const allocs = new Map(); // opts index -> allocated amount
    let left = amount;
    opts.forEach((opt, i) => {
        if (left <= 0) return;
        let alloc = Math.min(opt.remaining, left);
        if (opt.card.rounding === "block") {
            alloc = Math.floor(alloc / opt.card.blockSize) * opt.card.blockSize;
        }
        alloc = cents(alloc);
        if (alloc <= 0) return;
        allocs.set(i, alloc);
        left = cents(left - alloc);
    });
    if (allocs.size === 0) return null;
    if (left > 0) {
        let target = null;
        allocs.forEach((v, i) => {
            if (target === null || (opts[i].card.baseMpd || 0) > (opts[target].card.baseMpd || 0)) target = i;
        });
        allocs.set(target, cents(allocs.get(target) + left));
    }

    const parts = [];
    allocs.forEach((alloc, i) => {
        const opt = opts[i];
        const earn = computeEarn(opt.card, opt.rule, alloc, opt.used);
        parts.push({
            cardId: opt.card.id,
            cardName: opt.card.name,
            amount: alloc,
            miles: earn.miles
        });
    });
    if (parts.length < 2) return null;
    return {
        parts,
        totalMiles: Math.round(parts.reduce((s, p) => s + p.miles, 0) * 100) / 100
    };
}

// Split applies only when enabled, the user hasn't pinned a card, the amount
// overflows the single best card, and splitting actually earns more.
function maybeGetSplitPlan(amount, type) {
    if (!loadAppSettings().overflowSplit || userCardOverride) return null;
    const rec = getBestCardForSpend(amount, type);
    if (!rec || amount <= rec.remaining) return null;
    const plan = getSplitPlanForSpend(amount, type);
    if (!plan || plan.totalMiles <= rec.miles) return null;
    return plan;
}

function renderRecommendation() {
    const amountRaw = document.getElementById("purchaseAmount").value;
    const amount = Number(amountRaw);
    const type = getSelectedPurchaseType();
    const container = document.getElementById("inlineRecommendation");
    if (!Number.isFinite(amount) || amount <= 0) {
        container.hidden = true;
        return;
    }
    const rec = getBestCardForSpend(amount, type);
    if (!rec) {
        container.hidden = true;
        return;
    }

    // Opt-in overflow handling: show a split instead when it earns more
    const plan = maybeGetSplitPlan(amount, type);
    if (plan) {
        container.hidden = false;
        container.innerHTML = `
            <div class="rec-title">Best Split for $${amount.toFixed(2)}:</div>
            ${plan.parts.map(p => `
                <div class="rec-split-part">
                    <span class="rec-split-amount">$${p.amount.toFixed(2)}</span> on
                    <span class="rec-split-card"></span>
                    <span class="rec-split-miles">+${p.miles.toLocaleString()} mi</span>
                </div>`).join("")}
            <div class="rec-miles">Total Miles: <span>${plan.totalMiles.toLocaleString()}</span></div>
            <div class="rec-rule">Adding logs one purchase per card</div>
        `;
        // Card names via textContent (they're user-editable config)
        container.querySelectorAll(".rec-split-card").forEach((el, i) => {
            el.textContent = plan.parts[i].cardName;
        });
        return;
    }

    const card = getCardById(rec.cardId);
    if (!card) {
        container.hidden = true;
        return;
    }
    container.hidden = false;
    container.innerHTML = `
        <div class="rec-title">Best Card for $${amount.toFixed(2)}:</div>
        <div class="rec-card">${card.name}</div>
        <div class="rec-miles">Miles: <span>${rec.miles.toLocaleString()}</span></div>
        <div class="rec-breakdown">
            <span>Bonus: ${rec.breakdown.bonus.toFixed(2)}</span>
            <span>Base: ${rec.breakdown.base.toFixed(2)}</span>
        </div>
        <div class="rec-rule">Rule: ${rec.ruleLabel}</div>
    `;

    // Auto-select best card unless user has overridden. View-only: nothing is
    // persisted while typing — the selection is saved when the purchase is added.
    const cardSelector = document.getElementById("cardSelector");
    if (!userCardOverride && cardSelector.value !== rec.cardId) {
        cardSelector.value = rec.cardId;
        const view = loadState();
        view.selectedCardId = rec.cardId;
        renderSummary(view);
        renderTransactions(view);
    }
}
// CARD CONFIGURATION SYSTEM
// ===============================
// Card config lives in localStorage ("milesTrackerConfig") so caps/categories
// can be edited in-app when banks change T&Cs. DEFAULT_CARDS seeds it once and
// is otherwise never used. Transaction data ("milesTrackerState") references
// cards by id, so ids are immutable once created.
const CONFIG_KEY = "milesTrackerConfig";
const CONFIG_VERSION = 1;

const DEFAULT_CARDS = [
    {
        id: "uob_ppv",
        name: "UOB PPV",
        baseMpd: 0.4,
        rounding: "block",
        blockSize: 5,
        resetDay: 1,
        rules: [
            { type: "contactless", mpd: 4, cap: 540 },
            { type: "online", mpd: 4, cap: 540 }
        ]
    },
    {
        id: "hsbc_revolution",
        name: "HSBC Revolution",
        baseMpd: 0.33,
        resetDay: 1,
        rules: [
            { type: "shared", mpd: 3.33, cap: 1500, appliesTo: ["contactless", "online"] }
        ]
    }
];

function normalizeCard(card) {
    return {
        id: String(card.id),
        name: String(card.name || card.id),
        baseMpd: Number(card.baseMpd) || 0,
        rounding: card.rounding === "block" ? "block" : "exact",
        blockSize: Number(card.blockSize) || 5,
        resetDay: Math.min(31, Math.max(1, Math.round(Number(card.resetDay)) || 1)),
        minSpend: Number(card.minSpend) > 0 ? Number(card.minSpend) : null,
        rules: (Array.isArray(card.rules) ? card.rules : [])
            .filter(r => r && r.type)
            .map(r => ({
                type: String(r.type),
                mpd: Number(r.mpd) || 0,
                cap: Number(r.cap) || 0,
                ...(r.type === "shared"
                    ? { appliesTo: (Array.isArray(r.appliesTo) ? r.appliesTo : []).map(String) }
                    : {})
            }))
    };
}

function loadCardConfig() {
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.cards) && parsed.cards.length > 0) {
                return parsed.cards.map(normalizeCard);
            }
        }
    } catch (e) { /* fall through to defaults */ }
    return DEFAULT_CARDS.map(normalizeCard);
}

function saveCardConfig(newCards) {
    try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify({ version: CONFIG_VERSION, cards: newCards }));
    } catch (e) {
        alert("Could not save card settings (storage may be full or blocked).");
    }
}

// Seed config on first run of this version; existing transaction data is never touched.
function seedCardConfigOnce() {
    try {
        if (!localStorage.getItem(CONFIG_KEY)) {
            saveCardConfig(DEFAULT_CARDS.map(normalizeCard));
        }
    } catch (e) { /* non-fatal: in-memory defaults still work */ }
}

let cards = loadCardConfig();

// All categories a purchase can be tagged with, in config order.
function getAllCategories() {
    const seen = [];
    cards.forEach(card => {
        card.rules.forEach(rule => {
            const cats = rule.type === "shared" ? (rule.appliesTo || []) : [rule.type];
            cats.forEach(c => { if (c && !seen.includes(c)) seen.push(c); });
        });
    });
    return seen.length ? seen : ["contactless", "online"];
}

// A specific rule for the category wins; otherwise a shared pool that covers it.
function findRuleForType(card, type) {
    let idx = card.rules.findIndex(r => r.type === type);
    if (idx === -1) {
        idx = card.rules.findIndex(r =>
            r.type === "shared" && (!r.appliesTo || r.appliesTo.length === 0 || r.appliesTo.includes(type))
        );
    }
    return { rule: idx === -1 ? null : card.rules[idx], ruleIdx: idx };
}

function labelForRule(rule) {
    if (rule.type === "shared") return "All Spend";
    return rule.type[0].toUpperCase() + rule.type.slice(1);
}

// ===============================
// APP SETTINGS (behavior toggles, separate from card config and data)
// ===============================
const SETTINGS_KEY = "milesTrackerSettings";

function loadAppSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
        if (s && typeof s === "object") return { overflowSplit: !!s.overflowSplit };
    } catch (e) { /* fall through */ }
    return { overflowSplit: false };
}

function saveAppSettings(settings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) { /* non-fatal */ }
}

// ===============================
// STATE MANAGEMENT
// ===============================
function getDefaultState() {
    return {
        selectedCardId: "uob_ppv",
        transactions: []
    };
}

function loadState() {
    const raw = localStorage.getItem("milesTrackerState");
    if (!raw) return getDefaultState();
    let state = null;
    try {
        state = JSON.parse(raw);
    } catch (e) {
        // Unreadable value: preserve it untouched for manual recovery, never overwrite it silently
        try {
            if (!localStorage.getItem("milesTrackerState_corrupt")) {
                localStorage.setItem("milesTrackerState_corrupt", raw);
            }
        } catch (e2) { /* storage full — nothing more we can do */ }
        if (!window.__corruptStateWarned) {
            window.__corruptStateWarned = true;
            alert("Stored data could not be read. A copy was preserved under 'milesTrackerState_corrupt'.");
        }
        return getDefaultState();
    }
    if (!state || typeof state !== "object") return getDefaultState();
    if (!state.selectedCardId) state.selectedCardId = "uob_ppv";
    if (!state.transactions) state.transactions = [];
    return state;
}

function saveState(state) {
    try {
        localStorage.setItem("milesTrackerState", JSON.stringify(state));
    } catch (e) {
        alert("Could not save data (storage may be full or blocked).");
    }
}

// One-time safety net: snapshot existing data before this version runs anything else.
function backupStateOnce() {
    try {
        const raw = localStorage.getItem("milesTrackerState");
        if (raw && !localStorage.getItem("milesTrackerState_backup")) {
            localStorage.setItem("milesTrackerState_backup", raw);
        }
    } catch (e) { /* non-fatal */ }
}

function getCardById(id) {
    return cards.find(c => c.id === id) || null;
}

// ===============================
// RENDER FUNCTIONS
// ===============================
function renderCardSelector(state) {
    const selector = document.getElementById("cardSelector");
    selector.innerHTML = "";
    cards.forEach(card => {
        const opt = document.createElement("option");
        opt.value = card.id;
        opt.textContent = card.name;
        if (card.id === state.selectedCardId) opt.selected = true;
        selector.appendChild(opt);
    });
    selector.onchange = () => {
        userCardOverride = true;
        state.selectedCardId = selector.value;
        saveState(state);
        renderAll(state);
    };
}

function renderPurchaseTypes() {
    const group = document.getElementById("purchaseTypeGroup");
    const previous = document.querySelector('input[name="purchaseType"]:checked')?.value;
    const categories = getAllCategories();
    const selected = categories.includes(previous) ? previous : categories[0];
    group.innerHTML = "";
    categories.forEach(cat => {
        const label = document.createElement("label");
        label.className = "toggle-option";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "purchaseType";
        input.value = cat;
        input.checked = cat === selected;
        input.addEventListener("change", () => {
            userCardOverride = false;
            renderRecommendation();
        });
        const span = document.createElement("span");
        span.textContent = cat[0].toUpperCase() + cat.slice(1);
        label.appendChild(input);
        label.appendChild(span);
        group.appendChild(label);
    });
}

function renderSummary(state) {
    // Total miles
    const totalMiles = state.transactions
        .filter(tx => tx.cardId === state.selectedCardId)
        .reduce((sum, tx) => sum + tx.miles, 0);
    document.getElementById("totalMiles").textContent = Math.floor(totalMiles).toLocaleString();

    // Progress bars
    renderProgressBars(state);
}

function renderProgressBars(state) {
    const card = getCardById(state.selectedCardId);
    const container = document.getElementById("progressBarsContainer");
    container.innerHTML = "";
    if (!card) return;

    card.rules.forEach((rule, idx) => {
        const label = `${labelForRule(rule)} (${rule.mpd} mpd)`;

        // Calculate remaining
        const used = getUsedAmountForRule(state, card, rule, idx);
        const remaining = Math.max(0, rule.cap - used);
        const pct = (remaining / rule.cap) * 100;

        // DOM
        const section = document.createElement("div");
        section.className = "progress-section";
        section.innerHTML = `
            <div class="progress-labels">
                <span>${label}</span>
                <span id="remainingText_${idx}">$${remaining.toFixed(0)} left</span>
            </div>
            <div class="progress-bar-bg">
                <div id="bar_${idx}" class="progress-fill" style="width:${pct}%;"></div>
            </div>
        `;
        container.appendChild(section);

        // Low-remaining state via CSS class so it stays theme/token driven
        const bar = section.querySelector(`#bar_${idx}`);
        if (pct < 15) bar.classList.add("low");
    });

    // Optional minimum-spend progress note
    if (card.minSpend) {
        const spent = state.transactions
            .filter(tx => tx.cardId === card.id)
            .reduce((sum, tx) => sum + tx.amount, 0);
        const note = document.createElement("div");
        note.className = "min-spend-note";
        note.textContent = spent >= card.minSpend
            ? `Min spend met ($${spent.toFixed(0)} / $${card.minSpend.toFixed(0)})`
            : `Min spend: $${spent.toFixed(0)} of $${card.minSpend.toFixed(0)}`;
        container.appendChild(note);
    }
}

// Helper: get used amount for a rule (handles shared/separate pools)
function getUsedAmountForRule(state, card, rule, ruleIdx) {
    if (rule.type === "shared") {
        // Sum spend for this card in the categories the shared pool covers
        const covers = (t) => !rule.appliesTo || rule.appliesTo.length === 0 || rule.appliesTo.includes(t);
        return state.transactions
            .filter(tx => tx.cardId === card.id && covers(tx.type))
            .reduce((sum, tx) => sum + tx.amount, 0);
    } else {
        // Only sum spend for this card and this type
        return state.transactions
            .filter(tx => tx.cardId === card.id && tx.type === rule.type)
            .reduce((sum, tx) => sum + tx.amount, 0);
    }
}

function renderTransactions(state) {
    const tableBody = document.getElementById("transactionList");
    tableBody.innerHTML = "";
    // Show only transactions for selected card
    const txs = state.transactions.filter(tx => tx.cardId === state.selectedCardId).slice().reverse();
    if (txs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tx-empty";
        empty.textContent = "No purchases yet";
        tableBody.appendChild(empty);
        return;
    }
    txs.forEach(tx => {
        const wrap = document.createElement("div");
        wrap.className = "tx-row-wrap";
        
        const row = document.createElement("div");
        row.className = "tx-row";
        row.dataset.datetime = tx.datetime;
        
        const cellDate = document.createElement("div");
        cellDate.className = "tx-row-cell date-cell";
        const { datePart, timePart } = formatTransactionDateSplit(tx.datetime);
        const dateValue = document.createElement("div");
        dateValue.className = "date-value";
        dateValue.textContent = datePart;
        const timeValue = document.createElement("div");
        timeValue.className = "time-value";
        timeValue.textContent = timePart;
        cellDate.appendChild(dateValue);
        cellDate.appendChild(timeValue);
        
        const cellType = document.createElement("div");
        cellType.className = "tx-row-cell";
        cellType.textContent = tx.type[0].toUpperCase() + tx.type.slice(1);
        
        const cellAmount = document.createElement("div");
        cellAmount.className = "tx-row-cell amount";
        cellAmount.textContent = tx.amount.toFixed(2);
        
        const cellMiles = document.createElement("div");
        cellMiles.className = "tx-row-cell miles";
        cellMiles.textContent = tx.miles.toFixed(2);
        
        row.appendChild(cellDate);
        row.appendChild(cellType);
        row.appendChild(cellAmount);
        row.appendChild(cellMiles);
        
        const deleteBg = document.createElement("div");
        deleteBg.className = "delete-bg";
        deleteBg.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M19 6.4L18.3 19c-.1 1.1-1 2-2.1 2H8.8c-1.1 0-2-1-2.1-2L5 6.4M10 11v6M14 11v6M15 6V5c0-.6-.4-1-1-1h-4c-.6 0-1 .4-1 1v1M3 6h18" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;
        deleteBg.addEventListener("click", () => handleDeleteTransaction(tx, state));
        
        wrap.appendChild(row);
        wrap.appendChild(deleteBg);
        tableBody.appendChild(wrap);
        
        // Attach swipe listeners
        attachSwipeListeners(row);
    });
}

// Swipe state tracking
let currentSwiped = null;
let swipeStartX = 0;
let swipeStartY = 0;

function attachSwipeListeners(rowElement) {
    const touchStartHandler = (e) => {
        // Close other open rows
        if (currentSwiped && currentSwiped !== rowElement) {
            currentSwiped.classList.remove("swiped");
        }
        swipeStartX = e.touches ? e.touches[0].clientX : e.clientX;
        swipeStartY = e.touches ? e.touches[0].clientY : e.clientY;
    };
    
    const touchMoveHandler = (e) => {
        if (!e.touches && !e.clientX) return; // Not a touch or mouse event
        const currentX = e.touches ? e.touches[0].clientX : e.clientX;
        const currentY = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = swipeStartX - currentX;
        const dy = Math.abs(swipeStartY - currentY);
        
        // Only prevent default on strong horizontal swipe
        if (Math.abs(dx) > 8 && dy < 50) {
            if (e.touches) {
                e.preventDefault();
            }
        }
    };
    
    const touchEndHandler = (e) => {
        const currentX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
        const dx = swipeStartX - currentX;
        
        if (dx > 8) {
            // Swiped left
            rowElement.classList.add("swiped");
            currentSwiped = rowElement;
        } else if (dx < -8) {
            // Swiped right
            rowElement.classList.remove("swiped");
            if (currentSwiped === rowElement) {
                currentSwiped = null;
            }
        }
    };
    
    // Touch events with passive listeners for scroll performance
    rowElement.addEventListener("touchstart", touchStartHandler, { passive: true });
    rowElement.addEventListener("touchmove", touchMoveHandler, { passive: false });
    rowElement.addEventListener("touchend", touchEndHandler, { passive: true });
    
    // Mouse events for desktop testing
    rowElement.addEventListener("mousedown", touchStartHandler);
    rowElement.addEventListener("mousemove", touchMoveHandler);
    rowElement.addEventListener("mouseup", touchEndHandler);
}

// Close swiped row on tap outside
document.addEventListener("click", (e) => {
    if (currentSwiped && !e.target.closest(".tx-row-wrap")) {
        currentSwiped.classList.remove("swiped");
        currentSwiped = null;
    }
});

// Delete transaction and show undo toast
let deletedTx = null;
let deletedIndex = null;
let undoTimer = null;

function handleDeleteTransaction(tx, state) {
    // Store for undo
    deletedTx = tx;
    deletedIndex = state.transactions.findIndex(t => t.datetime === tx.datetime);
    
    // Remove from state
    state.transactions.splice(deletedIndex, 1);
    saveState(state);
    renderAll(loadState());
    
    // Mark swipe hint as seen
    localStorage.setItem("swipeHintSeen", "1");
    
    // Show undo toast
    showUndoToast();
}

function showUndoToast() {
    const toast = document.getElementById("undoToast");
    const undoBtn = toast.querySelector(".undo-btn");
    
    // Clear existing timer
    if (undoTimer) {
        clearTimeout(undoTimer);
    }
    
    // Show toast
    toast.classList.add("show");
    
    // Remove undo handler if exists
    const oldBtn = undoBtn.cloneNode(true);
    undoBtn.parentNode.replaceChild(oldBtn, undoBtn);
    
    // Add undo handler
    oldBtn.addEventListener("click", handleUndo);
    
    // Auto-dismiss after 3500ms
    undoTimer = setTimeout(() => {
        toast.classList.remove("show");
        undoTimer = null;
    }, 3500);
}

function handleUndo() {
    if (deletedTx === null || deletedIndex === null) return;
    
    const state = loadState();
    state.transactions.splice(deletedIndex, 0, deletedTx);
    saveState(state);
    renderAll(loadState());
    
    const toast = document.getElementById("undoToast");
    toast.classList.remove("show");
    
    if (undoTimer) {
        clearTimeout(undoTimer);
        undoTimer = null;
    }
    
    deletedTx = null;
    deletedIndex = null;
}

// ===============================
// ADD PURCHASE LOGIC
// ===============================
function addPurchase() {
    const state = loadState();
    // The selector reflects the live recommendation; it is the source of truth
    // for which card the purchase goes on, persisted only now (at add time).
    const selector = document.getElementById("cardSelector");
    const selectedId = selector && selector.value ? selector.value : state.selectedCardId;
    const card = getCardById(selectedId);
    const raw = document.getElementById("purchaseAmount").value;
    const purchaseAmount = Number(raw);
    const type = getSelectedPurchaseType();

    if (!card) {
        alert("Selected card not found. Please pick a card.");
        return;
    }
    if (!Number.isFinite(purchaseAmount) || purchaseAmount <= 0) {
        alert("Please enter a valid amount greater than 0.");
        return;
    }
    state.selectedCardId = selectedId;

    // Opt-in overflow handling: log the recommended split, one tx per card
    const plan = maybeGetSplitPlan(purchaseAmount, type);
    if (plan) {
        const now = Date.now();
        plan.parts.forEach((part, i) => {
            state.transactions.push({
                // Offset per part: datetime doubles as the tx identity for delete/undo
                datetime: new Date(now + i).toISOString(),
                cardId: part.cardId,
                type,
                amount: part.amount,
                miles: part.miles
            });
        });
        document.getElementById("purchaseAmount").value = "";
        saveState(state);
        renderAll(state);
        showAddedToast(plan.totalMiles);
        return;
    }

    // Find matching rule
    const { rule, ruleIdx } = findRuleForType(card, type);
    if (!rule) {
        alert(`${card.name} has no earn rule for ${type} spend.`);
        return;
    }

    // Calculate earn; warn when the cap truncates the bonus
    const used = getUsedAmountForRule(state, card, rule, ruleIdx);
    const earn = computeEarn(card, rule, purchaseAmount, used);
    if (purchaseAmount > earn.remaining) {
        alert(`Only $${earn.remaining.toFixed(0)} eligible for bonus miles`);
    }

    // Store transaction
    state.transactions.push({
        datetime: new Date().toISOString(),
        cardId: card.id,
        type,
        amount: purchaseAmount,
        miles: earn.miles
    });

    // Clear the input before re-rendering so the recommendation doesn't
    // recompute against the already-logged amount and flip the selection.
    document.getElementById("purchaseAmount").value = "";
    saveState(state);
    renderAll(state);
    showAddedToast(earn.miles);
}

// ===============================
// SETTINGS EDITOR
// ===============================
// Edits happen on a working copy; nothing is persisted until Save validates.
let editingCards = null;

function showSettingsError(msg) {
    const el = document.getElementById("settingsError");
    el.textContent = msg;
    el.hidden = false;
    el.scrollIntoView({ block: "nearest" });
}

function hideSettingsError() {
    const el = document.getElementById("settingsError");
    el.hidden = true;
    el.textContent = "";
}

function openSettings() {
    editingCards = JSON.parse(JSON.stringify(cards));
    hideSettingsError();
    renderSettingsEditor();
    document.getElementById("overflowSplitToggle").checked = loadAppSettings().overflowSplit;
    const panel = document.getElementById("settingsPanel");
    if (typeof panel.showModal === "function") panel.showModal();
    else panel.setAttribute("open", "");
}

function closeSettings() {
    editingCards = null;
    hideSettingsError();
    const panel = document.getElementById("settingsPanel");
    if (typeof panel.close === "function") panel.close();
    else panel.removeAttribute("open");
}

function settingsInput(value, opts = {}) {
    const input = document.createElement("input");
    input.type = opts.type || "text";
    input.className = "settings-input" + (opts.className ? " " + opts.className : "");
    if (input.type === "checkbox") {
        input.checked = !!value;
    } else {
        input.value = value === null || value === undefined ? "" : String(value);
        input.inputMode = opts.inputMode || "decimal";
        input.autocomplete = "off";
        if (opts.placeholder) input.placeholder = opts.placeholder;
    }
    if (opts.label) input.setAttribute("aria-label", opts.label);
    return input;
}

function settingsField(labelText, inputEl) {
    const label = document.createElement("label");
    label.className = "settings-field";
    const span = document.createElement("span");
    span.textContent = labelText;
    label.appendChild(span);
    label.appendChild(inputEl);
    return label;
}

// Rule <-> editor row mapping: a row lists the categories the rule covers.
// One category = its own cap pool; several categories = one shared pool.
function ruleToCategoriesText(rule) {
    if (rule.type === "shared") return (rule.appliesTo || []).join(", ");
    return rule.type;
}

function categoriesTextToRule(text, mpd, cap) {
    const cats = text.split(",").map(c => c.trim().toLowerCase()).filter(Boolean);
    if (cats.length === 0) return null;
    if (cats.length === 1) return { type: cats[0], mpd, cap };
    return { type: "shared", appliesTo: cats, mpd, cap };
}

function renderSettingsEditor() {
    const container = document.getElementById("settingsCards");
    container.innerHTML = "";

    editingCards.forEach((card, ci) => {
        const block = document.createElement("div");
        block.className = "settings-card";

        // Header: name + remove
        const head = document.createElement("div");
        head.className = "settings-card-head";
        const nameInput = settingsInput(card.name, { label: "Card name", className: "settings-name", inputMode: "text" });
        nameInput.addEventListener("input", () => { card.name = nameInput.value; });
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "settings-remove";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => {
            if (editingCards.length === 1) {
                showSettingsError("At least one card is required.");
                return;
            }
            const txCount = loadState().transactions.filter(tx => tx.cardId === card.id).length;
            const msg = txCount > 0
                ? `${txCount} logged transaction(s) reference ${card.name}. They will stay in your history but no longer count toward any cap. Remove this card?`
                : `Remove ${card.name}?`;
            if (!confirm(msg)) return;
            editingCards.splice(ci, 1);
            renderSettingsEditor();
        });
        head.appendChild(nameInput);
        head.appendChild(removeBtn);
        block.appendChild(head);

        // Card-level numbers
        const grid = document.createElement("div");
        grid.className = "settings-grid";
        const baseInput = settingsInput(card.baseMpd, { label: "Base mpd" });
        baseInput.addEventListener("input", () => { card.baseMpd = baseInput.value; });
        const resetInput = settingsInput(card.resetDay, { label: "Reset day of month", inputMode: "numeric" });
        resetInput.addEventListener("input", () => { card.resetDay = resetInput.value; });
        const minSpendInput = settingsInput(card.minSpend, { label: "Minimum spend (optional)", placeholder: "none" });
        minSpendInput.addEventListener("input", () => { card.minSpend = minSpendInput.value; });
        const blockInput = settingsInput(card.rounding === "block" ? card.blockSize : "", { label: "Earn block size in dollars", inputMode: "numeric", placeholder: "exact" });
        blockInput.addEventListener("input", () => {
            card.rounding = blockInput.value.trim() ? "block" : "exact";
            card.blockSize = blockInput.value;
        });
        grid.appendChild(settingsField("Base mpd", baseInput));
        grid.appendChild(settingsField("Reset day", resetInput));
        grid.appendChild(settingsField("Min spend $", minSpendInput));
        grid.appendChild(settingsField("$ block", blockInput));
        block.appendChild(grid);

        // Rules
        const rulesWrap = document.createElement("div");
        rulesWrap.className = "settings-rules";
        const rulesHead = document.createElement("div");
        rulesHead.className = "settings-rule settings-rule-head";
        ["Categories", "mpd", "Cap $", ""].forEach(t => {
            const s = document.createElement("span");
            s.textContent = t;
            rulesHead.appendChild(s);
        });
        rulesWrap.appendChild(rulesHead);

        card.rules.forEach((rule, ri) => {
            const row = document.createElement("div");
            row.className = "settings-rule";
            const catsInput = settingsInput(ruleToCategoriesText(rule), { label: "Categories (comma-separated)", inputMode: "text" });
            catsInput.addEventListener("input", () => { rule._catsText = catsInput.value; });
            rule._catsText = ruleToCategoriesText(rule);
            const mpdInput = settingsInput(rule.mpd, { label: "Miles per dollar" });
            mpdInput.addEventListener("input", () => { rule.mpd = mpdInput.value; });
            const capInput = settingsInput(rule.cap, { label: "Monthly cap in SGD" });
            capInput.addEventListener("input", () => { rule.cap = capInput.value; });
            const ruleRemove = document.createElement("button");
            ruleRemove.type = "button";
            ruleRemove.className = "settings-remove settings-remove-rule";
            ruleRemove.textContent = "✕";
            ruleRemove.setAttribute("aria-label", "Remove rule");
            ruleRemove.addEventListener("click", () => {
                card.rules.splice(ri, 1);
                renderSettingsEditor();
            });
            row.appendChild(catsInput);
            row.appendChild(mpdInput);
            row.appendChild(capInput);
            row.appendChild(ruleRemove);
            rulesWrap.appendChild(row);
        });
        block.appendChild(rulesWrap);

        const addRuleBtn = document.createElement("button");
        addRuleBtn.type = "button";
        addRuleBtn.className = "settings-add-rule";
        addRuleBtn.textContent = "+ Add rule";
        addRuleBtn.addEventListener("click", () => {
            card.rules.push({ type: "", mpd: 4, cap: 0 });
            renderSettingsEditor();
        });
        block.appendChild(addRuleBtn);

        container.appendChild(block);
    });
}

function slugifyCardId(name) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "card";
    let id = base;
    let n = 2;
    const taken = (candidate) => editingCards.some(c => c.id === candidate) || cards.some(c => c.id === candidate);
    while (taken(id)) id = `${base}_${n++}`;
    return id;
}

function addSettingsCard() {
    hideSettingsError();
    editingCards.push({
        id: slugifyCardId("New Card"),
        name: "New Card",
        baseMpd: 0.4,
        rounding: "exact",
        blockSize: 5,
        resetDay: 1,
        minSpend: null,
        rules: [{ type: "online", mpd: 4, cap: 0 }]
    });
    renderSettingsEditor();
    // Focus the new card's name field so it can be renamed inline (no prompt())
    const nameInputs = document.querySelectorAll("#settingsCards .settings-name");
    const last = nameInputs[nameInputs.length - 1];
    if (last) { last.focus(); last.select(); }
}

function saveSettings() {
    hideSettingsError();
    const cleaned = [];
    for (const card of editingCards) {
        const name = String(card.name || "").trim();
        if (!name) { showSettingsError("Every card needs a name."); return; }
        const baseMpd = Number(card.baseMpd);
        if (!Number.isFinite(baseMpd) || baseMpd < 0) { showSettingsError(`${name}: base mpd must be a number ≥ 0.`); return; }
        const resetDay = Math.round(Number(card.resetDay));
        if (!Number.isFinite(resetDay) || resetDay < 1 || resetDay > 31) { showSettingsError(`${name}: reset day must be between 1 and 31.`); return; }
        const minSpendRaw = String(card.minSpend ?? "").trim();
        const minSpend = minSpendRaw === "" ? null : Number(minSpendRaw);
        if (minSpend !== null && (!Number.isFinite(minSpend) || minSpend < 0)) { showSettingsError(`${name}: min spend must be a number ≥ 0.`); return; }
        const blockRaw = String(card.rounding === "block" ? card.blockSize : "").trim();
        const rounding = blockRaw === "" ? "exact" : "block";
        const blockSize = rounding === "block" ? Number(blockRaw) : 5;
        if (rounding === "block" && (!Number.isFinite(blockSize) || blockSize <= 0)) { showSettingsError(`${name}: block size must be a positive number.`); return; }

        if (!card.rules.length) { showSettingsError(`${name}: needs at least one earn rule.`); return; }
        const rules = [];
        for (const rule of card.rules) {
            const catsText = rule._catsText !== undefined ? rule._catsText : ruleToCategoriesText(rule);
            const mpd = Number(rule.mpd);
            const cap = Number(rule.cap);
            if (!Number.isFinite(mpd) || mpd < 0) { showSettingsError(`${name}: rule mpd must be a number ≥ 0.`); return; }
            if (!Number.isFinite(cap) || cap < 0) { showSettingsError(`${name}: rule cap must be a number ≥ 0.`); return; }
            const cats = String(catsText).split(",").map(c => c.trim().toLowerCase()).filter(Boolean);
            if (!cats.length) { showSettingsError(`${name}: every rule needs at least one category.`); return; }
            if (cats.includes("shared")) { showSettingsError(`${name}: "shared" is not a valid category name.`); return; }
            rules.push(categoriesTextToRule(cats.join(","), mpd, cap));
        }
        cleaned.push(normalizeCard({ ...card, name, baseMpd, resetDay, minSpend, rounding, blockSize, rules }));
    }

    cards = cleaned;
    saveCardConfig(cards);
    closeSettings();

    // Keep a valid selection if the selected card was removed
    const state = loadState();
    if (!getCardById(state.selectedCardId)) {
        state.selectedCardId = cards[0].id;
        saveState(state);
    }
    renderPurchaseTypes();
    renderAll(loadState());
}

// Small success cue after logging a purchase
let addToastTimer = null;
function showAddedToast(miles) {
    const toast = document.getElementById("addToast");
    toast.querySelector("span").textContent = `✓ Added — +${miles.toLocaleString()} miles`;
    toast.classList.add("show");
    const total = document.getElementById("totalMiles");
    total.classList.remove("pulse");
    void total.offsetWidth; // restart the animation
    total.classList.add("pulse");
    if (addToastTimer) clearTimeout(addToastTimer);
    addToastTimer = setTimeout(() => {
        toast.classList.remove("show");
        addToastTimer = null;
    }, 1800);
}

// ===============================
// CSV EXPORT (fully client-side)
// ===============================
function csvEscape(value) {
    const s = String(value ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function ruleCategoryLabel(rule) {
    if (rule.type === "shared") {
        return (rule.appliesTo && rule.appliesTo.length) ? rule.appliesTo.join(" + ") : "all";
    }
    return rule.type;
}

function buildCsv(state) {
    const txs = state.transactions;
    const rows = [];
    const isoDay = (d) => d.toISOString().slice(0, 10);
    const times = txs.map(tx => new Date(tx.datetime).getTime()).filter(Number.isFinite);
    const from = times.length ? isoDay(new Date(Math.min(...times))) : "-";
    const to = times.length ? isoDay(new Date(Math.max(...times))) : "-";

    rows.push(["Miles Tracker export"]);
    rows.push(["Exported on", isoDay(new Date())]);
    rows.push(["Period covered", from, to]);
    rows.push([]);

    // Summary: one row per card x cap pool, attributing each transaction to
    // the rule it matched when it was logged.
    rows.push(["Card", "Category", "Spend (SGD)", "Cap (SGD)", "Remaining (SGD)", "Miles Earned"]);
    let totalSpend = 0;
    let totalMiles = 0;
    cards.forEach(card => {
        const cardTxs = txs.filter(tx => tx.cardId === card.id);
        card.rules.forEach((rule, idx) => {
            const used = getUsedAmountForRule(state, card, rule, idx);
            const remaining = Math.max(0, rule.cap - used);
            const miles = cardTxs
                .filter(tx => findRuleForType(card, tx.type).ruleIdx === idx)
                .reduce((sum, tx) => sum + tx.miles, 0);
            rows.push([
                card.name,
                ruleCategoryLabel(rule),
                used.toFixed(2),
                rule.cap.toFixed(2),
                remaining.toFixed(2),
                miles.toFixed(2)
            ]);
        });
        // Spend on this card not covered by any rule (category with no earn rule)
        const uncovered = cardTxs.filter(tx => !findRuleForType(card, tx.type).rule);
        if (uncovered.length) {
            rows.push([
                card.name,
                "other",
                uncovered.reduce((s, tx) => s + tx.amount, 0).toFixed(2),
                "",
                "",
                uncovered.reduce((s, tx) => s + tx.miles, 0).toFixed(2)
            ]);
        }
        totalSpend += cardTxs.reduce((s, tx) => s + tx.amount, 0);
        totalMiles += cardTxs.reduce((s, tx) => s + tx.miles, 0);
    });
    // Transactions referencing cards removed from config
    const knownIds = cards.map(c => c.id);
    const orphanTxs = txs.filter(tx => !knownIds.includes(tx.cardId));
    if (orphanTxs.length) {
        const byCard = {};
        orphanTxs.forEach(tx => {
            const key = tx.cardId + "|" + tx.type;
            byCard[key] = byCard[key] || { spend: 0, miles: 0, cardId: tx.cardId, type: tx.type };
            byCard[key].spend += tx.amount;
            byCard[key].miles += tx.miles;
        });
        Object.values(byCard).forEach(g => {
            rows.push([`${g.cardId} (removed card)`, g.type, g.spend.toFixed(2), "", "", g.miles.toFixed(2)]);
        });
        totalSpend += orphanTxs.reduce((s, tx) => s + tx.amount, 0);
        totalMiles += orphanTxs.reduce((s, tx) => s + tx.miles, 0);
    }
    rows.push(["TOTAL", "", totalSpend.toFixed(2), "", "", totalMiles.toFixed(2)]);
    rows.push([]);

    // Full transaction log so the export is a complete record before a reset
    rows.push(["Transactions"]);
    rows.push(["Date", "Card", "Category", "Amount (SGD)", "Miles"]);
    txs.forEach(tx => {
        const card = getCardById(tx.cardId);
        rows.push([
            tx.datetime,
            card ? card.name : tx.cardId,
            tx.type,
            tx.amount.toFixed(2),
            tx.miles.toFixed(2)
        ]);
    });

    // BOM so Numbers/Excel detect UTF-8
    return "\uFEFF" + rows.map(r => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

async function exportCsv() {
    const state = loadState();
    const csv = buildCsv(state);
    const filename = `miles-tracker-${new Date().toISOString().slice(0, 10)}.csv`;

    // 1) iOS-friendly: share sheet with a real file (Save to Files, AirDrop, Mail...)
    try {
        const file = new File([csv], filename, { type: "text/csv" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: "Miles Tracker export" });
            return;
        }
    } catch (e) {
        if (e && e.name === "AbortError") return; // user closed the share sheet
        // fall through to download
    }

    // 2) Plain download link
    try {
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        return;
    } catch (e) { /* fall through to clipboard */ }

    // 3) Last resort: clipboard
    try {
        await navigator.clipboard.writeText(csv);
        alert("Download unavailable — CSV copied to clipboard instead.");
    } catch (e) {
        alert("Export failed on this browser.");
    }
}

// ===============================
// RESET FUNCTIONALITY
// ===============================
async function resetTracker() {
    const state = loadState();
    if (state.transactions.length && confirm("Export a CSV backup before resetting?")) {
        await exportCsv();
    }
    if (!confirm("Reset all data?")) return;
    localStorage.removeItem("milesTrackerState");
    renderAll(getDefaultState());
}

// ===============================
// UTILS
// ===============================
function getSelectedPurchaseType() {
    const checked = document.querySelector('input[name="purchaseType"]:checked');
    return checked ? checked.value : getAllCategories()[0];
}

function formatTransactionDate(datetimeString) {
    const date = new Date(datetimeString);
    const datePart = date.toLocaleDateString("en-SG", {
        day: "2-digit",
        month: "short"
    });
    let timePart = date.toLocaleTimeString("en-SG", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
    });
    timePart = timePart.replace(/ /, "\u00A0").replace(/am|pm/i, match => match.toUpperCase());
    return `${datePart} • ${timePart}`;
}

function formatTransactionDateSplit(datetimeString) {
    const date = new Date(datetimeString);
    const datePart = date.toLocaleDateString("en-SG", {
        day: "2-digit",
        month: "short"
    });
    let timePart = date.toLocaleTimeString("en-SG", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
    });
    timePart = timePart.replace(/ /, "\u00A0").replace(/am|pm/i, match => match.toUpperCase());
    return { datePart, timePart };
}

// ===============================
// THEME (system / light / dark)
// ===============================
// Preference is stored as "light" | "dark" | absent (follow the OS). The <head>
// resolver applies the theme before paint; these keep the toggle + chrome in sync.
const THEME_KEY = "ascentTheme";

const THEME_ICONS = {
    system: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor"/></svg>`,
    light: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
    dark: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>`
};

function getThemePref() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
}

function setThemePref(value) {
    try {
        if (value === null) localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, value);
    } catch (e) { /* non-fatal: choice just won't persist */ }
}

function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function applyTheme() {
    const pref = getThemePref();
    const dark = pref ? pref === "dark" : systemPrefersDark();
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? "#0d1517" : "#f3f1ea";

    const btn = document.getElementById("themeToggle");
    if (btn) {
        const mode = pref || "system";
        btn.innerHTML = THEME_ICONS[mode];
        const label = mode[0].toUpperCase() + mode.slice(1);
        btn.setAttribute("aria-label", `Theme: ${label} (tap to change)`);
        btn.setAttribute("title", `Theme: ${label}`);
    }
}

// Cycle System → Light → Dark → System
function cycleTheme() {
    const pref = getThemePref();
    const next = pref === null ? "light" : pref === "light" ? "dark" : null;
    setThemePref(next);
    applyTheme();
}

// ===============================
// MAIN RENDER
// ===============================
function renderAll(state) {
    renderCardSelector(state);
    renderSummary(state);
    renderTransactions(state);
    renderRecommendation();
}

// ===============================
// INIT
// ===============================
window.onload = () => {
    backupStateOnce();
    seedCardConfigOnce();
    const state = loadState();
    renderPurchaseTypes();
    renderAll(state);
    document.getElementById("resetButton").onclick = resetTracker;
    document.getElementById("addButton").onclick = addPurchase;
    // Theme toggle + keep "system" in sync with live OS changes
    applyTheme();
    document.getElementById("themeToggle").onclick = cycleTheme;
    if (window.matchMedia) {
        window.matchMedia("(prefers-color-scheme: dark)")
            .addEventListener("change", () => { if (getThemePref() === null) applyTheme(); });
    }
    document.getElementById("exportButton").onclick = exportCsv;
    document.getElementById("settingsButton").onclick = openSettings;
    document.getElementById("settingsCloseButton").onclick = closeSettings;
    document.getElementById("settingsSaveButton").onclick = saveSettings;
    document.getElementById("settingsAddCardButton").onclick = addSettingsCard;
    // Native dialog dismissal (Esc / backdrop) should drop the working copy too
    document.getElementById("settingsPanel").addEventListener("close", () => {
        editingCards = null;
        hideSettingsError();
    });
    document.getElementById("overflowSplitToggle").addEventListener("change", (e) => {
        const settings = loadAppSettings();
        settings.overflowSplit = e.target.checked;
        saveAppSettings(settings);
        renderRecommendation();
    });
    // Live recommendation updates
    // iPhone/mobile: focus input on load, larger touch targets
    const purchaseInput = document.getElementById("purchaseAmount");
    setTimeout(() => { purchaseInput.blur(); }, 100); // Prevent auto-zoom on load
    purchaseInput.addEventListener("focus", function() {
        this.select();
    });
    purchaseInput.addEventListener("input", renderRecommendation);

    // The app no longer uses a service worker; clean up any old registration.
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.getRegistrations()
            .then((regs) => regs.forEach((reg) => reg.unregister()))
            .catch(() => { /* nothing to clean up */ });
    }
};
