// Bill Splitter — all logic. Pure functions up top (Node-testable), UI wiring below.
// Build: npx tsc   (emits app.js, which index.html loads as a plain script)

interface ParsedLine {
  name: string;
  price: number;
}

interface Item extends ParsedLine {
  id: number;
  payer: string;
  consumers: string[];
}

interface AppState {
  people: string[];
  items: Item[];
}

interface Settlement {
  balances: Record<string, number>; // cents; positive = is owed money
  transfers: { from: string; to: string; amount: number }[];
}

// Tesseract.js is loaded from a CDN <script>; module is only present under Node.
declare const Tesseract: {
  recognize(
    image: File,
    language: string,
    options: { logger: (progress: { status: string; progress: number }) => void }
  ): Promise<{ data: { text: string } }>;
};
declare const module: { exports: unknown } | undefined;

// ---------- pure functions ----------

// Lines that are receipt noise, not purchasable items.
const NOISE = /total|subtotal|sub-total|tax|vat|change|cash|credit|card|tender|balance|discount|service/i;

function parseReceiptText(text: string): ParsedLine[] {
  const items: ParsedLine[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    // "item name   12.50" — price (with optional thousands separators) at end of line
    const match = line.match(/^(.*?)[\s.]{2,}?\s*[$฿€£]?\s*(\d[\d,]*[.,]\d{2})\s*$/) ||
                  line.match(/^(.+?)\s+[$฿€£]?(\d[\d,]*[.,]\d{2})\s*$/);
    if (!match) continue;
    const name = match[1].replace(/[.\s]+$/, "").trim();
    if (!name || NOISE.test(name)) continue;
    const price = parseFloat(match[2].replace(/,(?=\d{3})/g, "").replace(",", "."));
    if (!isFinite(price) || price <= 0) continue;
    items.push({ name, price });
  }
  return items;
}

// Positive balance = is owed money. Integer cents throughout; remainder cents go to the first consumers.
function settle(items: Pick<Item, "price" | "payer" | "consumers">[], people: string[]): Settlement {
  const balances: Record<string, number> = {};
  for (const person of people) balances[person] = 0;
  for (const item of items) {
    const consumers = item.consumers.filter((name) => people.includes(name));
    if (!consumers.length || !people.includes(item.payer) || !(item.price > 0)) continue;
    const cents = Math.round(item.price * 100);
    balances[item.payer] += cents;
    const share = Math.floor(cents / consumers.length);
    let remainder = cents - share * consumers.length;
    for (const consumer of consumers) {
      balances[consumer] -= share + (remainder-- > 0 ? 1 : 0);
    }
  }
  // Greedy: repeatedly match largest debtor with largest creditor.
  const working = Object.entries(balances).filter(([, cents]) => cents !== 0)
    .map(([name, cents]) => ({ name, cents }));
  const transfers: Settlement["transfers"] = [];
  while (true) {
    working.sort((a, b) => a.cents - b.cents);
    const debtor = working[0], creditor = working[working.length - 1];
    if (!debtor || debtor.cents >= 0) break;
    const amount = Math.min(-debtor.cents, creditor.cents);
    transfers.push({ from: debtor.name, to: creditor.name, amount: amount / 100 });
    debtor.cents += amount;
    creditor.cents -= amount;
  }
  return { balances, transfers };
}

if (typeof module !== "undefined") module.exports = { parseReceiptText, settle };

// ---------- UI (browser only) ----------
if (typeof document !== "undefined") {
  let state: AppState = { people: [], items: [] };
  try {
    state = JSON.parse(localStorage.getItem("billSplitter") ?? "") || state;
  } catch { /* corrupt or empty state — start fresh */ }

  const save = () => localStorage.setItem("billSplitter", JSON.stringify(state));
  const elementById = (id: string) => document.getElementById(id) as HTMLElement;
  const money = (value: number) => value.toFixed(2);
  let lastPayer: string | null = null;

  function addItem(name: string, price: number): void {
    state.items.push({
      id: Date.now() + Math.random(),
      name,
      price,
      payer: lastPayer || state.people[0] || "",
      consumers: [...state.people],
    });
  }

  function escapeHtml(text: string): string {
    return String(text).replace(/[&<>"']/g, (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] as string));
  }

  function renderSettlement(): void {
    const { balances, transfers } = settle(state.items, state.people);
    const total = state.items.reduce((sum, item) => sum + (item.price > 0 ? item.price : 0), 0);
    elementById("settlement").innerHTML =
      `<p class="muted">Bill total: ${money(total)}</p>` +
      (transfers.length
        ? transfers.map((transfer) =>
            `<div class="transfer"><b>${escapeHtml(transfer.from)}</b> pays <b>${escapeHtml(transfer.to)}</b> <span class="amount">${money(transfer.amount)}</span></div>`).join("")
        : `<p class="muted">All settled — nobody owes anything.</p>`) +
      `<details><summary>Balances</summary>${Object.entries(balances)
        .map(([person, cents]) => `<div>${escapeHtml(person)}: ${money(cents / 100)}</div>`).join("")}</details>`;
  }

  function render(): void {
    save();
    // People chips
    elementById("peopleList").innerHTML = state.people
      .map((person) => `<span class="chip">${escapeHtml(person)}
        <button data-remove-person="${escapeHtml(person)}" aria-label="Remove ${escapeHtml(person)}">×</button></span>`)
      .join("");

    // Items
    elementById("itemsList").innerHTML = state.items.map((item) => {
      const invalid = !item.consumers.length || !item.payer;
      return `<div class="item ${invalid ? "invalid" : ""}" data-id="${item.id}">
        <div class="itemRow">
          <input class="itemName" value="${escapeHtml(item.name)}" aria-label="Item name">
          <input class="itemPrice" type="number" step="0.01" inputmode="decimal" value="${item.price}" aria-label="Price">
          <button class="deleteItem" aria-label="Delete item">🗑</button>
        </div>
        <div class="itemRow">
          <label>Paid by
            <select class="itemPayer">
              ${state.people.map((person) =>
                `<option ${person === item.payer ? "selected" : ""}>${escapeHtml(person)}</option>`).join("")}
            </select>
          </label>
          <span class="consumers">${state.people.map((person) =>
            `<button class="tag ${item.consumers.includes(person) ? "on" : ""}" data-consumer="${escapeHtml(person)}">${escapeHtml(person)}</button>`).join("")}
          </span>
        </div>
        ${invalid ? `<div class="warn">Needs a payer and at least one person tagged — excluded from settlement.</div>` : ""}
      </div>`;
    }).join("") || `<p class="muted">No items yet — scan a receipt or add one manually.</p>`;

    renderSettlement();
  }

  const findItem = (target: EventTarget | null): Item | undefined => {
    const itemElement = (target as Element | null)?.closest?.(".item") as HTMLElement | null;
    return state.items.find((candidate) => String(candidate.id) === itemElement?.dataset.id);
  };

  // People
  elementById("personForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const nameInput = elementById("personName") as HTMLInputElement;
    const name = nameInput.value.trim();
    if (name && !state.people.includes(name)) {
      state.people.push(name);
      // ponytail: new person is not retro-tagged onto existing items — tag manually if they shared
      render();
    }
    nameInput.value = "";
  });
  elementById("peopleList").addEventListener("click", (event) => {
    const name = (event.target as HTMLElement).dataset.removePerson;
    if (!name) return;
    state.people = state.people.filter((person) => person !== name);
    for (const item of state.items) {
      item.consumers = item.consumers.filter((person) => person !== name);
      if (item.payer === name) item.payer = "";
    }
    render();
  });

  // Manual item
  elementById("itemForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const nameInput = elementById("newItemName") as HTMLInputElement;
    const priceInput = elementById("newItemPrice") as HTMLInputElement;
    const name = nameInput.value.trim();
    const price = parseFloat(priceInput.value);
    if (name && price > 0) {
      addItem(name, price);
      nameInput.value = "";
      priceInput.value = "";
      render();
    }
  });

  // Item edits (event delegation)
  elementById("itemsList").addEventListener("input", (event) => {
    const item = findItem(event.target);
    if (!item) return;
    const target = event.target as HTMLInputElement;
    if (target.classList.contains("itemName")) item.name = target.value;
    if (target.classList.contains("itemPrice")) item.price = parseFloat(target.value) || 0;
    save();
    // re-render settlement only, so typing doesn't lose focus
    renderSettlement();
  });
  elementById("itemsList").addEventListener("change", (event) => {
    const item = findItem(event.target);
    const target = event.target as HTMLSelectElement;
    if (item && target.classList.contains("itemPayer")) {
      item.payer = target.value;
      lastPayer = item.payer;
      render();
    }
  });
  elementById("itemsList").addEventListener("click", (event) => {
    const item = findItem(event.target);
    if (!item) return;
    const target = event.target as HTMLElement;
    if (target.classList.contains("deleteItem")) {
      state.items = state.items.filter((candidate) => candidate !== item);
      render();
    } else if (target.dataset.consumer) {
      const name = target.dataset.consumer;
      item.consumers = item.consumers.includes(name)
        ? item.consumers.filter((person) => person !== name)
        : [...item.consumers, name];
      render();
    }
  });

  // OCR
  elementById("receiptFile").addEventListener("change", async (event) => {
    const fileInput = event.target as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) return;
    const status = elementById("ocrStatus");
    status.textContent = "Scanning… (first scan downloads the OCR engine)";
    try {
      const result = await Tesseract.recognize(file, "eng", {
        logger: (progress) => {
          if (progress.status === "recognizing text") {
            status.textContent = `Scanning… ${Math.round(progress.progress * 100)}%`;
          }
        },
      });
      const parsed = parseReceiptText(result.data.text);
      if (!parsed.length) {
        status.textContent = "Couldn't find item lines — add items manually below.";
      } else {
        for (const parsedItem of parsed) addItem(parsedItem.name, parsedItem.price);
        status.textContent = `Added ${parsed.length} item(s) — verify names and prices below.`;
        render();
      }
    } catch (error) {
      status.textContent = "Scan failed (" + (error as Error).message + ") — add items manually below.";
    }
    fileInput.value = "";
  });

  elementById("clearAll").addEventListener("click", () => {
    if (confirm("Clear all people and items?")) {
      state = { people: [], items: [] };
      render();
    }
  });

  render();
}
