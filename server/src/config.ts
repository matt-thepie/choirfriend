/**
 * Centralised config. Reads from process.env (populated by --env-file in dev).
 * Throws early if anything required is missing so misconfiguration fails loud.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export interface Config {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  /** Path to the SQLite database file. Created on first run if missing. */
  databaseFile: string;
  /** Used for signed cookies if/when we set our own; not used for sgmc_token. */
  sessionSecret: string;
  /** Where the React client lives — used for CORS + post-login redirect. */
  clientOrigin: string;
  b2: {
    keyId: string;
    applicationKey: string;
    bucket: string;
    publicBaseUrl: string;
  };
}

export function getConfig(): Config {
  return {
    port: Number(optional('PORT', '3001')),
    nodeEnv: (optional('NODE_ENV', 'development') as Config['nodeEnv']),
    databaseFile: optional('DATABASE_FILE', './data/choirfriend.db'),
    sessionSecret: required('SESSION_SECRET'),
    clientOrigin: optional('CLIENT_ORIGIN', 'http://localhost:5173'),
    b2: {
      keyId: optional('B2_KEY_ID', ''),
      applicationKey: optional('B2_APPLICATION_KEY', ''),
      bucket: optional('B2_BUCKET', 'choirfriend'),
      publicBaseUrl: optional('B2_PUBLIC_BASE_URL', 'https://media.mgd.scot'),
    },
  };
}
