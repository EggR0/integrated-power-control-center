import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { TaskEvent } from "./protocol";
import { loadOrCreateLedgerKey } from "./keyStore";

export interface EventLedger {
  append(event: TaskEvent): Promise<void>;
  list(taskId?: string): Promise<TaskEvent[]>;
}

interface EncryptedRecord {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

type SqlCipherDatabase = {
  pragma(statement: string): unknown;
  key(key: Buffer): void;
  exec(statement: string): void;
  prepare(statement: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): Array<{ event_json: string }> };
  close(): void;
};

/** SQLCipher-backed append-only ledger. The native dependency is optional so
 * the extension still starts on hosts where native modules are unavailable. */
export class SqlCipherEventLedger implements EventLedger {
  private readonly db: SqlCipherDatabase;
  private readonly key: Buffer;

  public constructor(private readonly filePath: string, key?: Buffer) {
    let Database: ((file: string) => SqlCipherDatabase) | undefined;
    try { Database = require("better-sqlite3-multiple-ciphers"); } catch (error) {
      throw new Error(`SQLCipher backend is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.key = key ?? loadOrCreateLedgerKey(`${filePath}.key`);
    if (this.key.length !== 32) throw new Error("SQLCipher ledger key must be 32 bytes.");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = Database!(filePath);
    this.db.pragma("cipher='sqlcipher'");
    this.db.key(this.key);
    const cipherVersion = this.db.pragma("cipher_version");
    if (!cipherVersion) throw new Error("SQLCipher is not active for the Integrated Power ledger.");
    this.db.exec("CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, event_json TEXT NOT NULL, created_at TEXT NOT NULL)");
  }

  public async append(event: TaskEvent): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO events (event_id, task_id, event_json, created_at) VALUES (?, ?, ?, ?)").run(event.id, event.taskId, JSON.stringify(event), event.createdAt);
  }

  public async list(taskId?: string): Promise<TaskEvent[]> {
    const rows = taskId
      ? this.db.prepare("SELECT event_json FROM events WHERE task_id = ? ORDER BY sequence").all(taskId)
      : this.db.prepare("SELECT event_json FROM events ORDER BY sequence").all();
    return rows.map((row) => JSON.parse(row.event_json) as TaskEvent);
  }

  public close(): void { this.db.close(); }
}

export function createPreferredEventLedger(filePath: string, key?: Buffer): EventLedger {
  try {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, { encoding: "utf8", flag: "r" }).trimStart().startsWith("{")) {
      return new EncryptedEventLedger(filePath, key);
    }
  } catch { /* probe below */ }
  try { return new SqlCipherEventLedger(filePath, key); } catch (error) {
    const fallbackPath = filePath.endsWith(".enc.jsonl") ? filePath : `${filePath}.jsonl`;
    return new EncryptedEventLedger(fallbackPath, key);
  }
}

/**
 * Machine-local encrypted append-only event ledger. Keys are obtained from the
 * platform credential store (Windows Credential Manager, macOS Keychain, or
 * Linux Secret Service) with a Windows user-scoped DPAPI fallback.
 *
 * The broker talks to this interface rather than a file format, so a
 * SQLCipher backend can be supplied without changing protocol or broker code.
 */
export class EncryptedEventLedger implements EventLedger {
  private readonly key: Buffer;

  public constructor(
    private readonly filePath: string,
    key?: Buffer,
  ) {
    this.key = key ?? loadOrCreateLedgerKey(`${filePath}.key`);
    if (this.key.length !== 32) throw new Error("Event ledger key must be 32 bytes.");
  }

  public async append(event: TaskEvent): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(event), "utf8"),
      cipher.final(),
    ]);
    const record: EncryptedRecord = {
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    await fs.promises.appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  public async list(taskId?: string): Promise<TaskEvent[]> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: TaskEvent[] = [];
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line) as EncryptedRecord;
        if (record.version !== 1 || !record.iv || !record.tag || !record.ciphertext) continue;
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          this.key,
          Buffer.from(record.iv, "base64url"),
        );
        decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(record.ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
        const event = JSON.parse(plaintext) as TaskEvent;
        if (!taskId || event.taskId === taskId) events.push(event);
      } catch {
        // Gracefully ignore legacy binary SQLite data or unparseable records
      }
    }
    return events;
  }
}
