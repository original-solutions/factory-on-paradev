// @effect-diagnostics nodeBuiltinImport:off - the tests make and remove real temp directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach } from "vitest";

import { isLedgerError, type LedgerError } from "./errors.ts";

/**
 * Temp directories for one test file: each call makes a fresh empty directory, and all of them
 * are removed after every test. Call it once at the top of a `describe`.
 */
export const useTempDirs = () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });
  return (name = "t"): string => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `factory-ledger-${name}-`));
    dirs.push(dir);
    return dir;
  };
};

/**
 * The ledger error that `run` throws, checked to be an `expected` when one is given; fails the
 * test when it throws nothing or something else.
 */
export function catchLedgerError(run: () => unknown): LedgerError;
export function catchLedgerError<E>(run: () => unknown, expected: new (...args: never) => E): E;
export function catchLedgerError(
  run: () => unknown,
  expected?: new (...args: never) => unknown,
): unknown {
  try {
    run();
  } catch (error) {
    if (expected ? error instanceof expected : isLedgerError(error)) return error;
    throw error;
  }
  throw new Error("expected a ledger error, but nothing was thrown");
}

/** A clock that starts at `start` and moves on by `step` ms every time it is read. */
export const ticking = (start: number, step: number): (() => number) => {
  let now = start;
  return () => {
    const value = now;
    now += step;
    return value;
  };
};

/** A clock that returns the given times in order, and throws if it is read more often. */
export const scripted = (times: ReadonlyArray<number>): (() => number) => {
  const queue = [...times];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("clock read too often");
    return next;
  };
};

/** 2026-10-04T10:13:16.123Z */
export const T0 = 1791108796123;
