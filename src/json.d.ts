// `JSON.rawJSON` (Node 21+, TC39 JSON.parse source text access), which TypeScript's lib does not
// declare yet. `ledger/events.ts` writes an issue number from its digits with it.
interface JSON {
  rawJSON(text: string): unknown;
}
