import type { Config } from './config.js';

export function buildBasicAuthHeader(cfg: Config): string {
  // TFS PAT: basic auth with empty username and the token as password.
  const encoded = Buffer.from(`:${cfg.token}`, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}
