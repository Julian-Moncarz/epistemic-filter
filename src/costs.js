// Cost tracking for API usage — backed by better-sqlite3
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

// --- Pricing constants (easy to update) ---
const PRICING = {
  anthropic: {
    'claude-haiku-4-5-20251001': {
      input_per_mtok: 0.80,
      output_per_mtok: 4.00,
    },
  },
  deepgram: {
    nova2_per_min: 0.0043,
  },
  elevenlabs: {
    per_1k_chars: parseFloat(process.env.ELEVENLABS_COST_PER_1K_CHARS || '0.30'),
  },
  twilio: {
    inbound_per_min: 0.0085,
  },
};

// --- Helper functions ---
export function anthropicCost(usage, model = 'claude-haiku-4-5-20251001') {
  const p = PRICING.anthropic[model];
  if (!p) return { input: 0, output: 0, total: 0 };
  const input = (usage.input_tokens / 1_000_000) * p.input_per_mtok;
  const output = (usage.output_tokens / 1_000_000) * p.output_per_mtok;
  return { input, output, total: input + output };
}

export function deepgramCost(seconds) {
  return (seconds / 60) * PRICING.deepgram.nova2_per_min;
}

export function elevenlabsCost(chars) {
  return (chars / 1000) * PRICING.elevenlabs.per_1k_chars;
}

export function twilioCost(seconds) {
  return (seconds / 60) * PRICING.twilio.inbound_per_min;
}

// --- CostTracker class ---
export class CostTracker {
  constructor(dbPath = 'data/costs.db') {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_costs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        service TEXT NOT NULL,
        operation TEXT NOT NULL,
        units REAL NOT NULL,
        unit_label TEXT NOT NULL,
        estimated_cost_usd REAL NOT NULL,
        call_id TEXT,
        metadata TEXT
      )
    `);

    this._insertStmt = this.db.prepare(`
      INSERT INTO api_costs (timestamp, service, operation, units, unit_label, estimated_cost_usd, call_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  log(service, operation, units, unitLabel, costUsd, callId = null, metadata = null) {
    this._insertStmt.run(
      new Date().toISOString(),
      service,
      operation,
      units,
      unitLabel,
      costUsd,
      callId,
      metadata ? JSON.stringify(metadata) : null,
    );
  }

  summary(since = null) {
    const sinceDate = since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const rows = this.db.prepare(`
      SELECT service, COUNT(*) as calls, SUM(estimated_cost_usd) as total_usd
      FROM api_costs
      WHERE timestamp >= ?
      GROUP BY service
    `).all(sinceDate);

    const byService = {};
    let totalUsd = 0;
    for (const row of rows) {
      byService[row.service] = { total_usd: row.total_usd, calls: row.calls };
      totalUsd += row.total_usd;
    }

    return {
      since: sinceDate,
      total_usd: totalUsd,
      by_service: byService,
    };
  }

  recent(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM api_costs ORDER BY id DESC LIMIT ?
    `).all(limit);
  }

  close() {
    this.db.close();
  }
}
