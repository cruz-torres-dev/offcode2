// SQLite-only asynchronous access. Transactions receive a scoped executor;
// unrelated requests wait until COMMIT/ROLLBACK, even across awaited work.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configurationError = (message) =>
  Object.assign(new Error(message), { code: "DB_CONFIG", status: 500 });

export function resolveDatabaseConfig(env = process.env, overrides = {}) {
  const driver = String(overrides.driver ?? env.DB_DRIVER ?? "sqlite").toLowerCase();
  if (driver !== "sqlite")
    throw configurationError("Solo se admite SQLite. Retira DB_DRIVER del entorno o establece sqlite; revisa DATABASE_PATH antes de reiniciar.");
  if (env.RENDER === "true" && overrides.path === undefined && env.DATABASE_PATH !== "/var/data/offcode.sqlite")
    throw configurationError("En Render debes confirmar DATABASE_PATH=/var/data/offcode.sqlite y el disco persistente en /var/data. No se selecciona otra base automáticamente.");
  const file = overrides.path ?? env.DATABASE_PATH ?? "./data/offcode.sqlite";
  if (typeof file !== "string" || !file.trim())
    throw configurationError("DATABASE_PATH debe indicar un archivo SQLite privado.");
  if (file !== ":memory:") {
    const publicRoot = fileURLToPath(new URL("../dist/", import.meta.url));
    const relative = path.relative(publicRoot, path.resolve(file));
    if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)))
      throw configurationError("DATABASE_PATH debe quedar fuera de dist y de los archivos públicos.");
  }
  return { driver: "sqlite", path: file };
}

// No global re-entrancy flag: it would let other requests join an open
// transaction. Use the raw executor provided by tx() inside its callback.
function createMutex() {
  let chain = Promise.resolve();
  return (task) => {
    const next = chain.then(task);
    chain = next.catch(() => {});
    return next;
  };
}

async function openSqlite(config) {
  const file = config.path;
  const memory = file === ":memory:";
  if (!memory) mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  // WAL keeps readers (and the tests that inspect the file) from blocking the
  // writer; busy_timeout absorbs a second process opening the same file.
  if (!memory) db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  // Enforce inventory and catalog references on every connection.
  db.exec("PRAGMA foreign_keys=ON");
  const serialize = createMutex();

  const raw = {
    all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
    run(sql, params = []) {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes ?? 0), insertId: Number(result.lastInsertRowid ?? 0) };
    },
    exec(sql) {
      db.exec(sql);
    },
  };

  const api = {
    dialect: "sqlite",
    describe: () => ({ driver: "sqlite", path: memory ? ":memory:" : file }),
    all: (sql, params) => serialize(() => raw.all(sql, params)),
    get: (sql, params) => serialize(() => raw.get(sql, params)),
    run: (sql, params) => serialize(() => raw.run(sql, params)),
    exec: (sql) => serialize(() => raw.exec(sql)),
    // BEGIN IMMEDIATE takes the write lock before the first read, which is what
    // prevents two concurrent requests from both passing the stock check.
    async tx(fn) {
      return serialize(async () => {
        raw.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(raw);
          raw.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            raw.exec("ROLLBACK");
          } catch {}
          throw error;
        }
      });
    },
    async health() {
      const row = await api.get("SELECT 1 AS ok");
      if (row?.ok !== 1) throw configurationError("SQLite no responde.");
      return true;
    },
    close: () => serialize(() => db.close()),
  };
  return api;
}

export async function openDatabase(options = {}) {
  const config = resolveDatabaseConfig(options.env ?? process.env, {
    driver: options.driver, path: options.path,
  });
  return openSqlite(config);
}

export function isUniqueViolation(error) {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(String(error?.message ?? ""));
}
