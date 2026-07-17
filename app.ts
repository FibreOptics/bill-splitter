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

// `module` exists only under Node (test.js imports settle from the compiled output).
declare const module: { exports: unknown } | undefined;

// ---------- pure functions ----------

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

if (typeof module !== "undefined") module.exports = { settle };

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

  const DOT_COLORS = ["#1e6e4e", "#b3372c", "#22577a", "#a4611c", "#5b4b8a", "#2a7f8f", "#8a3d62", "#556b2f"];
  const personDot = (name: string) =>
    `<span class="dot" style="background:${DOT_COLORS[Math.max(0, state.people.indexOf(name)) % DOT_COLORS.length]}"></span>`;

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

    // Per-person summary: paid (fronted money), share (their part of the bill), net.
    const paidCents: Record<string, number> = {};
    for (const person of state.people) paidCents[person] = 0;
    for (const item of state.items) {
      const valid = item.price > 0 && state.people.includes(item.payer) &&
        item.consumers.some((name) => state.people.includes(name));
      if (valid) paidCents[item.payer] += Math.round(item.price * 100);
    }

    elementById("settlement").innerHTML =
      `<div class="total"><span>Bill total</span><span>${money(total)}</span></div>` +
      (transfers.length
        ? transfers.map((transfer) =>
            `<div class="transfer"><span class="who">${personDot(transfer.from)} ${escapeHtml(transfer.from)}
              <span class="arrow">pays →</span> ${personDot(transfer.to)} ${escapeHtml(transfer.to)}</span>
              <span class="amount">${money(transfer.amount)}</span></div>`).join("")
        : `<p class="settled">· ALL SETTLED ·</p>`) +
      `<div class="balances">${state.people.map((person) => {
        const net = balances[person] ?? 0;
        const share = paidCents[person] - net;
        return `<div class="balanceRow">
          <span class="who">${personDot(person)} ${escapeHtml(person)}</span>
          <span class="paidNote">paid ${money(paidCents[person] / 100)} · share ${money(share / 100)}</span>
          <span class="${net > 0 ? "pos" : net < 0 ? "neg" : "paidNote"}">${net > 0 ? "gets back " : net < 0 ? "owes " : "even "}${money(Math.abs(net) / 100)}</span>
        </div>`;
      }).join("")}</div>`;
  }

  function render(): void {
    save();
    // People chips
    elementById("peopleList").innerHTML = state.people
      .map((person) => `<span class="chip">${personDot(person)}${escapeHtml(person)}
        <button data-remove-person="${escapeHtml(person)}" aria-label="Remove ${escapeHtml(person)}">×</button></span>`)
      .join("") || `<p class="muted">Add everyone on the bill first.</p>`;

    // Items
    elementById("itemsList").innerHTML = state.items.map((item) => {
      const invalid = !item.consumers.length || !item.payer;
      const shareCount = item.consumers.length;
      return `<div class="item ${invalid ? "invalid" : ""}" data-id="${item.id}">
        <div class="itemRow">
          <input class="itemName" value="${escapeHtml(item.name)}" aria-label="Item name">
          <input class="itemPrice" type="number" step="0.01" inputmode="decimal" value="${item.price}" aria-label="Price">
          <button class="deleteItem" aria-label="Delete item">✕</button>
        </div>
        <div class="splitRow payerRow" role="radiogroup" aria-label="Who paid for ${escapeHtml(item.name)}">
          <span class="splitLabel">Paid by</span>
          <span>${state.people.map((person) =>
            `<button class="tag ${person === item.payer ? "on" : ""}" role="radio" aria-checked="${person === item.payer}"
              data-payer="${escapeHtml(person)}">${personDot(person)}${escapeHtml(person)}${person === item.payer ? " ✓" : ""}</button>`).join("")}
          </span>
        </div>
        <div class="splitRow" aria-label="Whose debt is ${escapeHtml(item.name)}">
          <span class="splitLabel">Debt of</span>
          <span>${state.people.map((person) =>
            `<button class="tag ${item.consumers.includes(person) ? "on" : ""}" aria-pressed="${item.consumers.includes(person)}"
              data-consumer="${escapeHtml(person)}">${personDot(person)}${escapeHtml(person)}</button>`).join("")}
          </span>
        </div>
        ${shareCount > 1 && item.price > 0
          ? `<div class="shareNote">${shareCount} people · ${money(item.price / shareCount)} each</div>` : ""}
        ${invalid ? `<div class="warn">Pick who paid and at least one debtor — excluded until then.</div>` : ""}
      </div>`;
    }).join("") || `<p class="muted">No items yet — scan a receipt or add one below.</p>`;

    const scanBlocked = state.people.length < 2;
    elementById("scanButton").classList.toggle("disabled", scanBlocked);
    (elementById("receiptFile") as HTMLInputElement).disabled = scanBlocked;
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
  elementById("itemsList").addEventListener("click", (event) => {
    const item = findItem(event.target);
    if (!item) return;
    const target = (event.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!target) return;
    if (target.classList.contains("deleteItem")) {
      state.items = state.items.filter((candidate) => candidate !== item);
      render();
    } else if (target.dataset.payer) {
      item.payer = target.dataset.payer;
      lastPayer = item.payer;
      render();
    } else if (target.dataset.consumer) {
      const name = target.dataset.consumer;
      item.consumers = item.consumers.includes(name)
        ? item.consumers.filter((person) => person !== name)
        : [...item.consumers, name];
      render();
    }
  });

  // Downscale to keep the upload small (serverless body limit) — vision doesn't need full camera resolution.
  async function fileToJpegBase64(file: File, maxEdge = 2048): Promise<string> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  }

  // Explain why the picker won't open while the input is disabled.
  elementById("scanButton").addEventListener("click", () => {
    if (state.people.length < 2) {
      elementById("ocrStatus").textContent = "Add at least 2 people before scanning.";
    }
  });

  // Scan via serverless vision endpoint
  elementById("receiptFile").addEventListener("change", async (event) => {
    const fileInput = event.target as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) return;
    const status = elementById("ocrStatus");
    if (state.people.length < 2) {
      status.textContent = "Add at least 2 people before scanning.";
      fileInput.value = "";
      return;
    }
    status.textContent = "Scanning…";
    try {
      const imageBase64 = await fileToJpegBase64(file);
      const scanResponse = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageBase64, mediaType: "image/jpeg" }),
      });
      const result = await scanResponse.json();
      if (!scanResponse.ok) throw new Error(result.error || scanResponse.statusText);
      const parsed: ParsedLine[] = (result.items ?? []).filter(
        (item: ParsedLine) => item.name && item.price > 0);
      if (!parsed.length) {
        status.textContent = "No items found on that image — add items manually below.";
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
