export interface Config {
  baseUrl: string;
  organization: string;
  token: string;
}

const DEFAULT_BASE_URL = 'http://tfs.example.com:8080/tfs';
const DEFAULT_ORG = 'DefaultCollection';

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function loadConfig(): Config {
  const token = readEnv('TFS_TOKEN');

  if (!token) {
    throw new Error(
      "Authentication required: set TFS_TOKEN (PAT) in the env block of ~/.claude/settings.json."
    );
  }

  const baseUrl = (readEnv('TFS_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const organization = readEnv('TFS_ORG') ?? DEFAULT_ORG;

  return { baseUrl, organization, token };
}
