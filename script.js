// ===============================
// ===============================
// RECOMMENDATION ENGINE
// ===============================
// Returns { cardId, miles, ruleType, ruleLabel, breakdown }
let userCardOverride = false;
function getBestCardForSpend(amount, type) {
    let best = null;
    cards.forEach(card => {
        // Find matching rule
        let ruleIdx = -1;
        let rule = null;
        if (card.rules.length === 1 && card.rules[0].type === "shared") {
            ruleIdx = 0;
            rule = card.rules[0];
        } else {
            ruleIdx = card.rules.findIndex(r => r.type === type);
            rule = card.rules[ruleIdx];
        }
        if (!rule) return;
        // Calculate used and remaining
        const state = loadState();
        let used = getUsedAmountForRule(state, card, rule, ruleIdx);
        let remaining = Math.max(0, rule.cap - used);
        let spend = Math.min(remaining, amount);
        let spendAt0 = amount - spend;
        // Miles calculation
        let miles = 0;
        const baseMpd = card.baseMpd || 0;
        let breakdown = {};
        if (card.rounding === "block") {
            const blocks = Math.floor(spend / card.blockSize);
            const blocksBase = Math.floor(spendAt0 / card.blockSize);
            miles += blocks * card.blockSize * rule.mpd;
            miles += blocksBase * card.blockSize * baseMpd;
            breakdown = {
                bonus: blocks * card.blockSize * rule.mpd,
                base: blocksBase * card.blockSize * baseMpd
            };
        } else {
            miles += spend * rule.mpd;
            miles += spendAt0 * baseMpd;
            breakdown = {
                bonus: spend * rule.mpd,
                base: spendAt0 * baseMpd
            };
        }
        miles = Math.round(miles * 100) / 100;
        if (!best || miles > best.miles) {
            best = {
                cardId: card.id,
                miles,
                ruleType: rule.type,
                ruleLabel: rule.type === "shared" ? "All Spend" : rule.type[0].toUpperCase() + rule.type.slice(1),
                breakdown
            };
        }
    });
    return best;
}

function renderRecommendation() {
    const amountRaw = document.getElementById("purchaseAmount").value;
    const amount = Number(amountRaw);
    const type = getSelectedPurchaseType();
    const container = document.getElementById("inlineRecommendation");
    if (!Number.isFinite(amount) || amount <= 0) {
        container.style.display = "none";
        return;
    }
    const rec = getBestCardForSpend(amount, type);
    if (!rec) {
        container.style.display = "none";
        return;
    }
    const card = cards.find(c => c.id === rec.cardId);
    container.style.display = "block";
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

    // Auto-select best card unless user has overridden
    const cardSelector = document.getElementById("cardSelector");
    if (!userCardOverride && cardSelector.value !== rec.cardId) {
        cardSelector.value = rec.cardId;
        // Update state and re-render summary/transactions only
        const state = loadState();
        state.selectedCardId = rec.cardId;
        saveState(state);
        renderSummary(state);
        renderTransactions(state);
    }
}
// CARD CONFIGURATION SYSTEM
// ===============================
const cards = [
    {
        id: "uob_ppv",
        name: "UOB PPV",
        baseMpd: 0.4,
        rounding: "block",
        blockSize: 5,
        rules: [
            { type: "contactless", mpd: 4, cap: 540 },
            { type: "online", mpd: 4, cap: 540 }
        ]
    },
    {
        id: "hsbc_revolution",
        name: "HSBC Revolution",
        baseMpd: 0.33,
        rules: [
            { type: "shared", mpd: 3.33, cap: 1500, appliesTo: ["contactless", "online"] }
        ]
    }
];

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
    const state = JSON.parse(localStorage.getItem("milesTrackerState"));
    if (!state) return getDefaultState();
    if (!state.selectedCardId) state.selectedCardId = "uob_ppv";
    if (!state.transactions) state.transactions = [];
    return state;
}

function saveState(state) {
    localStorage.setItem("milesTrackerState", JSON.stringify(state));
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
    const card = cards.find(c => c.id === state.selectedCardId);
    const container = document.getElementById("progressBarsContainer");
    container.innerHTML = "";

    card.rules.forEach((rule, idx) => {
        let label = "";
        if (rule.type === "contactless") label = `Contactless (${rule.mpd} mpd)`;
        else if (rule.type === "online") label = `Online (${rule.mpd} mpd)`;
        else if (rule.type === "shared") label = `All Spend (${rule.mpd} mpd)`;

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

        // Alert color if low
        const bar = section.querySelector(`#bar_${idx}`);
        if (pct < 15) {
            bar.style.background = "#ff4d4d";
            bar.style.boxShadow = "0 6px 12px rgba(255, 77, 77, 0.12)";
        } else {
            bar.style.background = "linear-gradient(90deg, var(--color-accent), var(--color-accent-2))";
            bar.style.boxShadow = "0 6px 12px rgba(221, 80, 19, 0.10)";
        }
    });
}

// Helper: get used amount for a rule (handles shared/separate pools)
function getUsedAmountForRule(state, card, rule, ruleIdx) {
    if (rule.type === "shared") {
        // Sum all spend for this card
        return state.transactions
            .filter(tx => tx.cardId === card.id)
            .reduce((sum, tx) => sum + tx.amount, 0);
    } else {
        // Only sum spend for this card and this type
        return state.transactions
            .filter(tx => tx.cardId === card.id && tx.type === rule.type)
            .reduce((sum, tx) => sum + tx.amount, 0);
    }
}

function renderTransactions(state) {
    const tableBody = document.querySelector("#transactionTable tbody");
    tableBody.innerHTML = "";
    // Show only transactions for selected card
    const txs = state.transactions.filter(tx => tx.cardId === state.selectedCardId).slice().reverse();
    txs.forEach(tx => {
        const row = document.createElement("tr");
        row.innerHTML = `
            <td>${formatTransactionDate(tx.datetime)}</td>
            <td>${tx.type[0].toUpperCase() + tx.type.slice(1)}</td>
            <td>${tx.amount.toFixed(2)}</td>
            <td>${tx.miles.toFixed(2)}</td>
        `;
        tableBody.appendChild(row);
    });
}

// ===============================
// ADD PURCHASE LOGIC
// ===============================
function addPurchase() {
    const state = loadState();
    const card = cards.find(c => c.id === state.selectedCardId);
    const raw = document.getElementById("purchaseAmount").value;
    const purchaseAmount = Number(raw);
    const type = getSelectedPurchaseType();

    if (!Number.isFinite(purchaseAmount) || purchaseAmount <= 0) {
        alert("Please enter a valid amount greater than 0.");
        return;
    }

    // Find matching rule
    let ruleIdx = -1;
    let rule = null;
    if (card.rules.length === 1 && card.rules[0].type === "shared") {
        ruleIdx = 0;
        rule = card.rules[0];
    } else {
        ruleIdx = card.rules.findIndex(r => r.type === type);
        rule = card.rules[ruleIdx];
    }

    // Calculate used and remaining
    let used = getUsedAmountForRule(state, card, rule, ruleIdx);
    let remaining = Math.max(0, rule.cap - used);
    let spend = Math.min(remaining, purchaseAmount);
    let spendAt0 = purchaseAmount - spend;

    // User warning for exceeding cap
    if (purchaseAmount > remaining) {
        alert(`Only $${remaining.toFixed(0)} eligible for bonus miles`);
    }

    // Config-driven miles calculation
    let miles = 0;
    const baseMpd = card.baseMpd || 0;
    if (card.rounding === "block") {
        const blocks = Math.floor(spend / card.blockSize);
        miles += blocks * card.blockSize * rule.mpd;
        const blocksBase = Math.floor(spendAt0 / card.blockSize);
        miles += blocksBase * card.blockSize * baseMpd;
    } else {
        miles += spend * rule.mpd;
        miles += spendAt0 * baseMpd;
    }
    // Floating point safety
    miles = Math.round(miles * 100) / 100;

    // Store transaction
    state.transactions.push({
        datetime: new Date().toISOString(),
        cardId: card.id,
        type,
        amount: purchaseAmount,
        miles
    });

    saveState(state);
    renderAll(state);

    // Reset input
    document.getElementById("purchaseAmount").value = "";
}

// ===============================
// RESET FUNCTIONALITY
// ===============================
function resetTracker() {
    if (!confirm("Reset all data?")) return;
    localStorage.removeItem("milesTrackerState");
    renderAll(getDefaultState());
}

// ===============================
// UTILS
// ===============================
function getSelectedPurchaseType() {
    return document.querySelector('input[name="purchaseType"]:checked').value;
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
    const state = loadState();
    renderAll(state);
    document.getElementById("resetButton").onclick = resetTracker;
    document.getElementById("addButton").onclick = addPurchase;
    // Live recommendation updates
    // iPhone/mobile: focus input on load, larger touch targets
    const purchaseInput = document.getElementById("purchaseAmount");
    setTimeout(() => { purchaseInput.blur(); }, 100); // Prevent auto-zoom on load
    purchaseInput.addEventListener("focus", function() {
        this.select();
    });
    purchaseInput.addEventListener("input", renderRecommendation);
    Array.from(document.querySelectorAll('input[name="purchaseType"]')).forEach(el => {
        el.addEventListener("change", function() {
            userCardOverride = false;
            renderRecommendation();
        });
    });
};
