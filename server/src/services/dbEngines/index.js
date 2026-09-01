import * as sqlite from './sqlite.js';
import * as postgres from './postgres.js';
import * as mongodb from './mongodb.js';
import * as oracle from './oracle.js';
import { DbExecutionError } from './common.js';

const ENGINES = { sqlite, postgres, mongodb, oracle };

export function getEngine(id) {
  return ENGINES[String(id || '').toLowerCase()] ?? null;
}

export async function runOnEngine(engineId, options) {
  const engine = getEngine(engineId);
  if (!engine) throw new DbExecutionError(`Unknown database engine: ${engineId}`);
  return engine.run(options);
}

/** Which engines this server can actually run right now, for /api/health. */
export async function engineAvailability() {
  const out = {};
  for (const [key, engine] of Object.entries(ENGINES)) {
    try {
      out[key] = await engine.isAvailable();
    } catch {
      out[key] = false;
    }
  }
  return out;
}

export async function shutdownEngines() {
  await mongodb.shutdown().catch(() => {});
}

export { DbExecutionError };
