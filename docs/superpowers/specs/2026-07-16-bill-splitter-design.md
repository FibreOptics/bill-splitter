# Bill Splitter — Design

Date: 2026-07-16
Status: built with recorded assumptions (user was AFK during brainstorming; revise freely)

## Goal

Minimal mobile-friendly web app: upload a receipt photo, OCR it into line items,
verify/edit the items, tag who pays for each item, and compute the minimal set of
"who pays who" transfers.

## Assumptions (made autonomously — confirm or change)

1. **One organizer, no accounts.** One person enters everything on one device.
   People are plain text name tags. No backend, no auth, no sharing links.
2. **OCR = Tesseract.js from CDN**, entirely client-side. No API keys, no server.
   Accuracy is mediocre on receipts, but the required verify/edit step covers it.
3. **Equal split per item** among the people tagged on that item. No percentage
   or share-weight splits.
4. **Single currency, no tax/tip distribution logic.** Tax/tip can be added as a
   manual line item and tagged like anything else.
5. Data persists in `localStorage` only.

## Architecture

Three files, no build step, no framework:

- `index.html` — markup + styles (mobile-first, single column)
- `app.js` — all logic; pure functions for parsing and settlement, exported for Node tests
- `test.js` — Node-runnable assertions for receipt-line parsing and settlement math

Tesseract.js loaded via `<script>` from jsDelivr CDN (needs network on first OCR).

## Data model (in-memory + localStorage)

```
state = {
  people: ["Non", "Aim", ...],
  items: [{ id, name, price, payer, consumers: ["Non","Aim"] }, ...]
}
```

Items come from OCR or manual entry — identical shape either way.

## Flow

1. **People** — add/remove name chips.
2. **Add items** — either "Scan receipt" (file input with `capture`, image → Tesseract →
   regex parse of `name ... price` lines) or "Add item" (manual name + price).
3. **Verify** — OCR results land in the same editable item list: fix names/prices,
   delete garbage lines, add missed ones.
4. **Tag** — per item: who paid (select) and who consumed (toggle chips). Bulk default:
   new items get the last-used payer and all people as consumers.
5. **Settle** — net balance per person (paid − consumed share), then greedy
   creditor/debtor matching for a minimal transfer list.

## Settlement algorithm

For each item: payer gains `price`; each of the n consumers owes `price / n`.
Work in integer cents to avoid float drift; remainder cents distributed to the
first consumers. Net balances, then repeatedly match the largest debtor with the
largest creditor until all balances are zero. Greedy gives ≤ (people − 1) transfers.

## Error handling

- OCR failure / no parseable lines → message + fall back to manual entry.
- Items with no consumers or price 0 are excluded from settlement (flagged in UI).
- localStorage read wrapped in try/catch; corrupt state resets cleanly.

## Testing

`node test.js` — asserts on `parseReceiptText` and `settle` (including cent-remainder
and multi-payer cases). No framework.

## Out of scope (YAGNI)

Accounts, sharing/sync, multi-currency, unequal split weights, receipt image storage,
payment integration (PromptPay/QR), history of past bills beyond current localStorage.
