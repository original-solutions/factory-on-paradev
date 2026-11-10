/** `\n`, which ends every line of a ledger file. */
export const NEWLINE = 0x0a;

/** The largest u32: softfac's type for an attempt number. */
export const U32_MAX = 4294967295;

/** A whole number from 0 to `U32_MAX`, which is what softfac reads an attempt as. */
export const isU32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= U32_MAX;
