import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString = process.env.POSTMARK_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("POSTMARK_SERVICE_DATABASE_URL is required");
}

const pool = new Pool({
  connectionString,
});

export const db = drizzle(pool, { schema });
export { pool };
