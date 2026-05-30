/**
 * Schema definitions shared by the SQLite and MySQL drivers.
 *
 * The app stores UUID string ids and ISO-8601 timestamp strings, so MySQL uses
 * VARCHAR where SQLite uses TEXT (TEXT can't be a primary/indexed key in MySQL
 * without a prefix length). Booleans are TINYINT/INTEGER 0|1 in both. Indexes
 * are emitted inline for MySQL and as standalone CREATE INDEX for SQLite.
 */
export function schemaStatements(dialect) {
  const mysql = dialect === "mysql";
  const ID = mysql ? "VARCHAR(64)" : "TEXT";
  const SHORT = mysql ? "VARCHAR(255)" : "TEXT";
  const TS = mysql ? "VARCHAR(40)" : "TEXT";
  const BOOL = mysql ? "TINYINT" : "INTEGER";
  const FLOAT = mysql ? "DOUBLE" : "REAL";
  const LONG = mysql ? "MEDIUMTEXT" : "TEXT";
  const AUTO_ID = mysql ? "BIGINT AUTO_INCREMENT PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  const ENGINE = mysql ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" : "";

  // Each table: [columns[], inlineConstraints[]]
  const tables = {
    cursor_accounts: {
      cols: [
        `id ${ID} PRIMARY KEY`,
        `name ${SHORT}`,
        `email ${SHORT}`,
        `user_id ${SHORT}`,
        `access_token TEXT NOT NULL`,
        `machine_id ${SHORT} NOT NULL`,
        `mac_machine_id ${SHORT}`,
        `ghost_mode ${BOOL} DEFAULT 1`,
        `priority INTEGER NOT NULL DEFAULT 1`,
        `is_active ${BOOL} DEFAULT 1`,
        `status ${mysql ? "VARCHAR(32)" : "TEXT"} DEFAULT 'active'`,
        `last_used_at ${TS}`,
        `consecutive_use_count INTEGER DEFAULT 0`,
        `backoff_level INTEGER DEFAULT 0`,
        `last_error ${mysql ? "VARCHAR(512)" : "TEXT"}`,
        `error_code INTEGER`,
        `last_error_at ${TS}`,
        `cooldown_until ${TS}`,
        `expires_at ${TS}`,
        `proxy_pool_id ${ID}`,
        `proxy_url ${SHORT}`,
        `total_requests INTEGER DEFAULT 0`,
        `total_errors INTEGER DEFAULT 0`,
        `usage_cents ${FLOAT}`,
        `usage_events INTEGER`,
        `usage_checked_at ${TS}`,
        `last_active_at ${TS}`,
        `created_at ${TS} NOT NULL`,
        `updated_at ${TS} NOT NULL`,
      ],
      mysqlIndexes: [
        "INDEX idx_acc_priority (priority)",
        "INDEX idx_acc_status (status, is_active)",
        "INDEX idx_acc_user (user_id)",
        "INDEX idx_acc_email (email)",
      ],
    },
    proxy_pools: {
      cols: [
        `id ${ID} PRIMARY KEY`,
        `name ${SHORT} NOT NULL`,
        `strategy ${mysql ? "VARCHAR(32)" : "TEXT"} DEFAULT 'round-robin'`,
        `proxies ${LONG} NOT NULL`,
        "`cursor` INTEGER DEFAULT 0", // `cursor` is a reserved word in MySQL

        `is_active ${BOOL} DEFAULT 1`,
        `created_at ${TS} NOT NULL`,
        `updated_at ${TS} NOT NULL`,
      ],
      mysqlIndexes: [],
    },
    admins: {
      cols: [
        `id ${ID} PRIMARY KEY`,
        `username ${mysql ? "VARCHAR(128)" : "TEXT"} NOT NULL`,
        `password_hash ${SHORT} NOT NULL`,
        `must_change ${BOOL} DEFAULT 0`,
        `created_at ${TS} NOT NULL`,
      ],
      mysqlIndexes: ["UNIQUE KEY uniq_admin_username (username)"],
      sqliteConstraints: ["UNIQUE (username)"],
    },
    api_keys: {
      cols: [
        `id ${ID} PRIMARY KEY`,
        `name ${SHORT}`,
        `key_hash ${mysql ? "VARCHAR(128)" : "TEXT"} NOT NULL`,
        `key_prefix ${mysql ? "VARCHAR(32)" : "TEXT"}`,
        `is_active ${BOOL} DEFAULT 1`,
        `last_used_at ${TS}`,
        `total_requests INTEGER DEFAULT 0`,
        `created_at ${TS} NOT NULL`,
      ],
      mysqlIndexes: ["INDEX idx_key_hash (key_hash)"],
    },
    settings: {
      cols: [
        `\`key\` ${mysql ? "VARCHAR(128)" : "TEXT"} PRIMARY KEY`,
        `\`value\` ${LONG}`,
      ],
      mysqlIndexes: [],
    },
    usage_log: {
      cols: [
        `id ${AUTO_ID}`,
        `account_id ${ID}`,
        `api_key_id ${ID}`,
        `model ${SHORT}`,
        `status INTEGER`,
        `ok ${BOOL}`,
        `created_at ${TS} NOT NULL`,
      ],
      mysqlIndexes: ["INDEX idx_usage_created (created_at)"],
    },
  };

  const out = [];
  for (const [name, def] of Object.entries(tables)) {
    const parts = [...def.cols];
    if (mysql) parts.push(...(def.mysqlIndexes || []));
    else parts.push(...(def.sqliteConstraints || []));
    out.push(`CREATE TABLE IF NOT EXISTS ${name} (\n  ${parts.join(",\n  ")}\n)${ENGINE}`);
  }
  return out;
}

/**
 * Columns added after the initial release. Applied idempotently on every boot
 * (ALTER TABLE ... ADD COLUMN if missing) so existing databases pick them up
 * without a manual migration. New databases already have them via CREATE TABLE.
 */
export function extraColumns(dialect) {
  const mysql = dialect === "mysql";
  const TS = mysql ? "VARCHAR(40)" : "TEXT";
  const FLOAT = mysql ? "DOUBLE" : "REAL";
  return [
    { table: "cursor_accounts", column: "usage_cents", type: FLOAT },
    { table: "cursor_accounts", column: "usage_events", type: "INTEGER" },
    { table: "cursor_accounts", column: "usage_checked_at", type: TS },
    { table: "cursor_accounts", column: "last_active_at", type: TS },
  ];
}

/** Standalone indexes for SQLite (run after the tables are created). */
export function sqliteIndexes() {
  return [
    "CREATE INDEX IF NOT EXISTS idx_acc_priority ON cursor_accounts(priority)",
    "CREATE INDEX IF NOT EXISTS idx_acc_status ON cursor_accounts(status, is_active)",
    "CREATE INDEX IF NOT EXISTS idx_acc_user ON cursor_accounts(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_acc_email ON cursor_accounts(email)",
    "CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_key_hash ON api_keys(key_hash)",
  ];
}
