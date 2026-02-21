import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import { ensureSchema } from "../db/schema";

type SqlCall = {
  text: string;
  values: unknown[];
};

function createSqlRecorder(): { sql: Sql; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return [] as unknown[];
  }) as unknown as Sql;

  return { sql, calls };
}

describe("db schema", () => {
  test("runs full schema bootstrap once and then short-circuits", async () => {
    const { sql, calls } = createSqlRecorder();

    await ensureSchema(sql);
    const firstPassCalls = calls.length;
    expect(firstPassCalls).toBeGreaterThan(20);

    const statements = calls.map((call) => call.text);
    expect(
      statements.some((stmt) => stmt.includes("create table if not exists accounts"))
    ).toBe(true);
    expect(
      statements.some((stmt) => stmt.includes("create table if not exists sessions"))
    ).toBe(true);
    expect(
      statements.some((stmt) => stmt.includes("create table if not exists resource_nodes"))
    ).toBe(true);
    expect(
      statements.some((stmt) => stmt.includes("create table if not exists agent_profiles"))
    ).toBe(true);
    expect(
      statements.some((stmt) =>
        stmt.includes("add column if not exists actor_type text not null default 'human'")
      )
    ).toBe(true);

    await ensureSchema(sql);
    expect(calls.length).toBe(firstPassCalls);
  });
});
