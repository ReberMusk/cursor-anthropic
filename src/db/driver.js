/**
 * Async database driver abstraction. Two backends:
 *   - sqlite (default) via better-sqlite3 (sync, wrapped in resolved promises)
 *   - mysql via mysql2/promise connection pool
 *
 * Repos talk to a uniform async API using positional `?` placeholders:
 *   run(sql, params)  -> { changes }
 *   get(sql, params)  -> row | undefined
 *   all(sql, params)  -> row[]
 *
 * Select the backend with DB_DRIVER=sqlite|mysql.
 *   sqlite: DATABASE_PATH (file)   default ./data/cursor-anthropic.db
 *   mysql:  DATABASE_URL (mysql://user:pass@host:3306/db) or DB_HOST/DB_PORT/...
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { schemaStatements, sqliteIndexes, extraColumns } from "./schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, "../../data/cursor-anthropic.db");

let driver = null;

export function getDriver() {
  if (!driver) throw new Error("DB not initialized — call initDb() first");
  return driver;
}

export async function initDb() {
  if (driver) return driver;
  const kind = (process.env.DB_DRIVER || "sqlite").toLowerCase();
  driver = kind === "mysql" ? await createMysqlDriver() : await createSqliteDriver();
  await driver.migrate();
  return driver;
}

export async function closeDb() {
  if (driver) { await driver.close(); driver = null; }
}

// ---------------- SQLite ----------------
async function createSqliteDriver() {
  const { default: Database } = await import("better-sqlite3");
  const dbPath = process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH) : DEFAULT_DB;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const conn = new Database(dbPath);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");

  const norm = (p = []) => p.map((v) => (v === undefined ? null : v));
  return {
    dialect: "sqlite",
    raw: conn,
    async run(sql, params = []) { const r = conn.prepare(sql).run(...norm(params)); return { changes: r.changes }; },
    async get(sql, params = []) { return conn.prepare(sql).get(...norm(params)); },
    async all(sql, params = []) { return conn.prepare(sql).all(...norm(params)); },
    async migrate() {
      for (const stmt of schemaStatements("sqlite")) conn.exec(stmt);
      for (const idx of sqliteIndexes()) conn.exec(idx);
      for (const c of extraColumns("sqlite")) {
        const cols = conn.prepare(`PRAGMA table_info(${c.table})`).all();
        if (!cols.some((x) => x.name === c.column)) {
          conn.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.type}`);
        }
      }
    },
    async close() { conn.close(); },
  };
}

// ---------------- MySQL ----------------
async function createMysqlDriver() {
  const mysql = await import("mysql2/promise");
  const cfg = process.env.DATABASE_URL
    ? { uri: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || "127.0.0.1",
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || "root",
        password: process.env.DB_PASSWORD || "",
        database: process.env.DB_NAME || "cursor_anthropic",
      };
  const pool = mysql.createPool({
    ...cfg,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL || 10),
    namedPlaceholders: false,
    charset: "utf8mb4",
  });

  const norm = (p = []) => p.map((v) => (v === undefined ? null : v));
  return {
    dialect: "mysql",
    raw: pool,
    async run(sql, params = []) { const [r] = await pool.execute(sql, norm(params)); return { changes: r.affectedRows }; },
    async get(sql, params = []) { const [rows] = await pool.execute(sql, norm(params)); return rows[0]; },
    async all(sql, params = []) { const [rows] = await pool.execute(sql, norm(params)); return rows; },
    async migrate() {
      for (const stmt of schemaStatements("mysql")) await pool.query(stmt);
      for (const c of extraColumns("mysql")) {
        const [rows] = await pool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?",
          [c.table, c.column]
        );
        if (!rows.length) await pool.query(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.type}`);
      }
    },
    async close() { await pool.end(); },
  };
}
