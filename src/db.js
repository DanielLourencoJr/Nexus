import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "data", "nexus.db");

import { mkdirSync } from "fs";
mkdirSync(join(__dirname, "..", "data"), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    cron TEXT NOT NULL,
    message TEXT NOT NULL,
    repeat INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// migração: adiciona coluna repeat se não existir (bancos criados antes desta versão)
try {
  db.exec("ALTER TABLE schedules ADD COLUMN repeat INTEGER NOT NULL DEFAULT 1");
} catch {
  // coluna já existe, ignora
}

export const Schedules = {
  insert(userId, username, cron, message, repeat = 1) {
    return db
      .prepare("INSERT INTO schedules (user_id, username, cron, message, repeat) VALUES (?, ?, ?, ?, ?)")
      .run(userId, username, cron, message, repeat ? 1 : 0);
  },

  findByUser(userId) {
    return db
      .prepare("SELECT * FROM schedules WHERE user_id = ?")
      .all(userId);
  },

  findAll() {
    return db.prepare("SELECT * FROM schedules").all();
  },

  delete(id, userId) {
    return db
      .prepare("DELETE FROM schedules WHERE id = ? AND user_id = ?")
      .run(id, userId);
  },
};

export default db;
