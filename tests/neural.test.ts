import { describe, expect, it } from "vitest";
import { serializeByTable } from "@/lib/neural";

/**
 * The kernel's writes are not atomic: five concurrent inserts into one table
 * were measured persisting nine rows, with duplicates and losses, while the
 * same five issued sequentially persisted exactly five. Everything here guards
 * the queue that makes that safe.
 */
describe("serializeByTable", () => {
  /** Runs for `ms`, recording when it was inside the critical section. */
  function tracked(log: string[], id: string, ms: number) {
    return async () => {
      log.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end:${id}`);
      return id;
    };
  }

  it("never overlaps two writes to the same table", async () => {
    const log: string[] = [];
    const table = `t_${Math.random()}`;

    await Promise.all([
      serializeByTable(table, tracked(log, "a", 30)),
      serializeByTable(table, tracked(log, "b", 5)),
      serializeByTable(table, tracked(log, "c", 1)),
    ]);

    // A strict start/end alternation proves no two ran at once.
    expect(log).toEqual([
      "start:a", "end:a",
      "start:b", "end:b",
      "start:c", "end:c",
    ]);
  });

  it("preserves submission order, not completion order", async () => {
    const log: string[] = [];
    const table = `t_${Math.random()}`;

    // The slowest task is submitted first; it must still finish first.
    const results = await Promise.all([
      serializeByTable(table, tracked(log, "slow", 25)),
      serializeByTable(table, tracked(log, "fast", 1)),
    ]);

    expect(results).toEqual(["slow", "fast"]);
    expect(log.indexOf("end:slow")).toBeLessThan(log.indexOf("start:fast"));
  });

  it("lets different tables proceed concurrently", async () => {
    const log: string[] = [];
    const suffix = Math.random();

    await Promise.all([
      serializeByTable(`a_${suffix}`, tracked(log, "a", 25)),
      serializeByTable(`b_${suffix}`, tracked(log, "b", 25)),
    ]);

    // Both must be inside the section before either leaves.
    expect(log.slice(0, 2).sort()).toEqual(["start:a", "start:b"]);
  });

  it("does not wedge the queue when a write fails", async () => {
    const table = `t_${Math.random()}`;

    const failed = serializeByTable(table, async () => {
      throw new Error("kernel rejected the write");
    });
    await expect(failed).rejects.toThrow("kernel rejected the write");

    // The next write must still run rather than hang behind the failure.
    await expect(
      serializeByTable(table, async () => "recovered"),
    ).resolves.toBe("recovered");
  });

  it("propagates each task's own return value", async () => {
    const table = `t_${Math.random()}`;
    const values = await Promise.all([
      serializeByTable(table, async () => 1),
      serializeByTable(table, async () => 2),
    ]);
    expect(values).toEqual([1, 2]);
  });
});
