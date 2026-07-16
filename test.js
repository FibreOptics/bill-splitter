// node test.js — fails loudly if parsing or settlement math breaks.
const assert = require("node:assert");
const { parseReceiptText, settle } = require("./app.js");

// --- parseReceiptText ---
const parsed = parseReceiptText(`
  SUPERMART STORE #42
  Pad Thai .......... 120.00
  Iced Latte   65.50
  2x Spring Roll  1,240.00
  SUBTOTAL 1425.50
  VAT 7% 99.79
  TOTAL 1,525.29
  CASH 2000.00
  CHANGE 474.71
`);
assert.deepStrictEqual(
  parsed.map((item) => [item.name, item.price]),
  [["Pad Thai", 120], ["Iced Latte", 65.5], ["2x Spring Roll", 1240]],
  "should extract item lines and skip totals/tax/cash noise"
);

// --- settle: basic two-person ---
let result = settle(
  [{ name: "Dinner", price: 100, payer: "A", consumers: ["A", "B"] }],
  ["A", "B"]
);
assert.deepStrictEqual(result.transfers, [{ from: "B", to: "A", amount: 50 }]);

// --- settle: cent remainder (100 / 3) sums exactly to zero ---
result = settle(
  [{ name: "Cake", price: 1.00, payer: "A", consumers: ["A", "B", "C"] }],
  ["A", "B", "C"]
);
const totalCents = Object.values(result.balances).reduce((sum, cents) => sum + cents, 0);
assert.strictEqual(totalCents, 0, "balances must sum to zero even with remainders");

// --- settle: multiple payers net out ---
result = settle(
  [
    { name: "Lunch", price: 30, payer: "A", consumers: ["A", "B", "C"] },
    { name: "Taxi", price: 30, payer: "B", consumers: ["A", "B", "C"] },
  ],
  ["A", "B", "C"]
);
// A and B each net +10, C owes 20 → exactly two transfers from C
assert.strictEqual(result.transfers.length, 2);
assert.ok(result.transfers.every((transfer) => transfer.from === "C"));
assert.strictEqual(result.transfers.reduce((sum, transfer) => sum + transfer.amount, 0), 20);

// --- settle: invalid items excluded ---
result = settle(
  [{ name: "Ghost", price: 50, payer: "A", consumers: [] }],
  ["A", "B"]
);
assert.deepStrictEqual(result.transfers, []);

console.log("All tests passed.");
