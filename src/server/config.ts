/**
 * Configuration loading. Everything has a default, so the app runs with no
 * config file at all, and the file only has to name what it changes.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_FILTER, type FilterConfig } from '../core/suitability.js';
import { DEFAULT_LAYOUT, type LayoutConfig } from '../core/layout.js';
import { DEFAULT_GRADES, type GradeMapping } from '../core/interaction.js';
import { DEFAULT_SESSION_OPTIONS, type SessionOptions } from './session.js';

export interface AppConfig {
  ankiConnectUrl: string;
  ankiConnectKey: string | null;
  host: string;
  port: number;
  /**
   * Key required on every endpoint that reads or writes the collection. Null
   * means one is generated at startup and printed with the pairing URL.
   */
  accessKey: string | null;
  /** Origins allowed to call the API cross site. Empty means none. */
  allowedOrigins: string[];
  filter: FilterConfig;
  session: Omit<SessionOptions, 'filter'>;
  grades: GradeMapping;
}

export const DEFAULT_CONFIG: AppConfig = {
  ankiConnectUrl: 'http://127.0.0.1:8765',
  ankiConnectKey: null,
  host: '0.0.0.0',
  port: 8710,
  accessKey: null,
  allowedOrigins: [],
  filter: DEFAULT_FILTER,
  session: DEFAULT_SESSION_OPTIONS,
  grades: DEFAULT_GRADES,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shallow merge per section, so a partial config keeps the other defaults. */
export function mergeConfig(base: AppConfig, override: unknown): AppConfig {
  if (!isRecord(override)) return base;

  const layer = override as Partial<Record<keyof AppConfig, unknown>>;
  const filter: FilterConfig = {
    ...base.filter,
    ...(isRecord(layer.filter) ? (layer.filter as Partial<FilterConfig>) : {}),
    layout: {
      ...base.filter.layout,
      ...(isRecord(layer.filter) && isRecord((layer.filter as Record<string, unknown>).layout)
        ? ((layer.filter as Record<string, unknown>).layout as Partial<LayoutConfig>)
        : {}),
    } as LayoutConfig,
  };

  return {
    ankiConnectUrl:
      typeof layer.ankiConnectUrl === 'string' ? layer.ankiConnectUrl : base.ankiConnectUrl,
    ankiConnectKey:
      typeof layer.ankiConnectKey === 'string' ? layer.ankiConnectKey : base.ankiConnectKey,
    host: typeof layer.host === 'string' ? layer.host : base.host,
    port: typeof layer.port === 'number' ? layer.port : base.port,
    accessKey: typeof layer.accessKey === 'string' ? layer.accessKey : base.accessKey,
    allowedOrigins: Array.isArray(layer.allowedOrigins)
      ? (layer.allowedOrigins as string[])
      : base.allowedOrigins,
    filter,
    session: {
      ...base.session,
      ...(isRecord(layer.session) ? (layer.session as Partial<AppConfig['session']>) : {}),
    },
    grades: {
      ...base.grades,
      ...(isRecord(layer.grades) ? (layer.grades as Partial<GradeMapping>) : {}),
    },
  };
}

export function loadConfig(path?: string): AppConfig {
  const file = path ?? process.env.ANKI_GLASSES_CONFIG ?? 'anki-glasses.config.json';
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(resolve(file), 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(`Could not read config ${file}: ${String(error)}`);
    }
  }

  let config = mergeConfig(DEFAULT_CONFIG, parsed);

  // Environment wins, so a one-off run can point at a different Anki.
  if (process.env.ANKI_CONNECT_URL) config.ankiConnectUrl = process.env.ANKI_CONNECT_URL;
  if (process.env.ANKI_GLASSES_KEY) config.accessKey = process.env.ANKI_GLASSES_KEY;
  if (process.env.ANKI_GLASSES_PORT) {
    const port = Number.parseInt(process.env.ANKI_GLASSES_PORT, 10);
    if (Number.isFinite(port)) config.port = port;
  }

  validateConfig(config);
  return config;
}

export function validateConfig(config: AppConfig): void {
  const layout = config.filter.layout;
  if (layout.charsPerLine < 10) throw new Error('filter.layout.charsPerLine is too small');
  if (layout.linesPerScreen < 1) throw new Error('filter.layout.linesPerScreen must be at least 1');
  if (layout.maxPages < 1) throw new Error('filter.layout.maxPages must be at least 1');
  if (config.port < 1 || config.port > 65535) throw new Error('port is out of range');
  if (config.accessKey !== null && config.accessKey.length < 16) {
    throw new Error('accessKey must be at least 16 characters, or null to generate one');
  }
  const eases = Object.values(config.grades);
  if (eases.some((ease) => ![1, 2, 3, 4].includes(ease))) {
    throw new Error('grades must map to an Anki ease of 1, 2, 3 or 4');
  }
}

export { DEFAULT_LAYOUT };
