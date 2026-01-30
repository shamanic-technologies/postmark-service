import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString = process.env.POSTMARK_SERVICE_DATABASE_URL || process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
});

export const db = drizzle(pool, { schema });
export { pool };
