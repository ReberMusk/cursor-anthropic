/**
 * DB entrypoint. The actual connection logic lives in driver.js (SQLite/MySQL).
 * Kept as a thin re-export so callers can `import { initDb } from "./db/index.js"`.
 */
export { initDb, closeDb, getDriver } from "./driver.js";
