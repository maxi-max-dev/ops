import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb(binding?: D1Database) {
  if (!binding) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Let the private runtime inject the real binding before using the database; GitHub Pages does not provide server-side bindings."
    );
  }

  return drizzle(binding, { schema });
}
