import postgres, { type Sql } from "postgres";

let cached: Sql | null | undefined;

export function getDbClient(): Sql | null {
  if (cached !== undefined) return cached;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    cached = null;
    return cached;
  }

  cached = postgres(connectionString, {
    max: 4,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  });

  return cached;
}

export async function closeDbClient(): Promise<void> {
  const client = getDbClient();
  if (!client) return;
  await client.end({ timeout: 2 });
  cached = undefined;
}
