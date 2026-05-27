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
  databaseUrl: string;
  sessionSecret: string;
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
    databaseUrl: required('DATABASE_URL'),
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
