import * as fs from "node:fs";
import * as path from "node:path";
import type { LedgerEvent } from "@harness/spec";

/**
 * The event-sourced run ledger. Append-only JSONL; run state is always a
 * pure fold over these events (see scheduler.foldState). Resume, audit,
 * replay, and the dashboard all read this one file.
 */
export class Journal {
  private readonly file: string;

  constructor(workspace: string) {
    this.file = path.join(workspace, "journal.jsonl");
  }

  append(event: LedgerEvent): void {
    const record = { ...event, ts: new Date().toISOString() };
    fs.appendFileSync(this.file, JSON.stringify(record) + "\n", "utf8");
  }

  read(): LedgerEvent[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LedgerEvent);
  }
}
