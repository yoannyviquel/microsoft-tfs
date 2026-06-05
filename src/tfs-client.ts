import type { Config } from './config.js';
import { buildBasicAuthHeader } from './auth.js';
import { TfsError } from './errors.js';
import type { TfsConnectionData } from './models/tfs.js';

export type QueryValue = string | number | boolean | undefined | null;
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  contentType?: string;
  operationName?: string;
}

export class TfsClient {
  private _authenticatedUserId?: string;

  constructor(private readonly cfg: Config) {}

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  get organization(): string {
    return this.cfg.organization;
  }

  url(path: string, query?: Record<string, QueryValue>): string {
    const sep = path.startsWith('/') ? '' : '/';
    let url = `${this.cfg.baseUrl}/${this.cfg.organization}${sep}${path}`;
    if (!query) return url;

    const parts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    if (parts.length === 0) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${parts.join('&')}`;
  }

  async request<T = unknown>(
    method: HttpMethod,
    url: string,
    body?: unknown,
    opts?: RequestOptions
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Authorization': buildBasicAuthHeader(this.cfg),
      'Accept': 'application/json',
      'User-Agent': 'microsoft-tfs/1.0',
    };

    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = opts?.contentType ?? 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();

    if (!res.ok) {
      let parsedMessage: string | undefined;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        parsedMessage = parsed?.message;
      } catch {
        // body wasn't JSON
      }
      throw new TfsError(
        opts?.operationName ?? `${method} ${url}`,
        res.status,
        parsedMessage ?? res.statusText ?? 'Unknown error',
        text
      );
    }

    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  get<T = unknown>(url: string, operationName?: string): Promise<T> {
    return this.request<T>('GET', url, undefined, { operationName });
  }

  async getAuthenticatedUserId(): Promise<string> {
    if (this._authenticatedUserId && this._authenticatedUserId.length > 0) {
      return this._authenticatedUserId;
    }
    const url = this.url('/_apis/connectionData', { 'api-version': '6.0-preview.1' });
    const data = await this.get<TfsConnectionData>(
      url,
      'retrieving the authenticated user'
    );
    const id = data?.authenticatedUser?.id;
    if (!id || id.trim().length === 0) {
      throw new Error(
        'Unable to resolve the authenticated user via /_apis/connectionData (id missing)'
      );
    }
    this._authenticatedUserId = id;
    return id;
  }
}
