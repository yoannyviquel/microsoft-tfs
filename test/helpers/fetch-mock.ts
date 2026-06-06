// Test harness — replaces the global `fetch` with a route-driven fake so tool
// handlers run their full real path (TfsClient URL building, Basic auth header,
// TfsError parsing, arg validation, markdown formatting) without any network.
//
// Every handler ultimately calls `globalThis.fetch` inside TfsClient.request —
// that is the single network seam. Mock it and you exercise everything else for real.

import { TfsClient } from '../../src/tfs-client.js';
import type { ToolContext } from '../../src/tools/types.js';

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface RouteResponse {
  /** HTTP status, default 200. */
  status?: number;
  statusText?: string;
  /** Object → JSON-serialized; string → sent verbatim; undefined → empty body. */
  body?: unknown;
}

export interface Route {
  /** Optional HTTP method filter (GET/POST/PATCH/DELETE…). */
  method?: string;
  /** URL matcher: substring, RegExp, or predicate. */
  match: string | RegExp | ((url: string) => boolean);
  respond: RouteResponse | ((url: string, init: RequestInit) => RouteResponse);
}

/** Base prefix produced by makeCtx (baseUrl + organization). */
export const BASE = 'http://tfs.test/tfs/DefaultCollection';

let originalFetch: typeof globalThis.fetch | undefined;
let routes: Route[] = [];

/** Every fetch the code under test issued, in order — assert against this. */
export const calls: RecordedCall[] = [];

function urlMatches(match: Route['match'], url: string): boolean {
  if (typeof match === 'string') return url.includes(match);
  if (match instanceof RegExp) return match.test(url);
  return match(url);
}

function makeResponse(r: RouteResponse): Response {
  const status = r.status ?? 200;
  const bodyText =
    r.body === undefined
      ? ''
      : typeof r.body === 'string'
        ? r.body
        : JSON.stringify(r.body);
  // Minimal Response shape — TfsClient only reads ok/status/statusText/text().
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: r.statusText ?? '',
    async text() {
      return bodyText;
    },
  } as unknown as Response;
}

export function installFetchMock(): void {
  if (!originalFetch) originalFetch = globalThis.fetch;
  routes = [];
  calls.length = 0;
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === 'string' ? init.body : undefined;
    calls.push({ method, url, headers, body });

    for (const r of routes) {
      if (r.method && r.method.toUpperCase() !== method) continue;
      if (!urlMatches(r.match, url)) continue;
      const resp = typeof r.respond === 'function' ? r.respond(url, init) : r.respond;
      return makeResponse(resp);
    }
    // No route matched → 404 so an unmocked call fails loudly instead of hanging.
    return makeResponse({
      status: 404,
      statusText: 'Not Found (no mock route)',
      body: { message: `No mock route for ${method} ${url}` },
    });
  }) as typeof globalThis.fetch;
}

export function restoreFetch(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
}

/** Register a response route. Routes are matched in registration order. */
export function route(r: Route): void {
  routes.push(r);
}

/** Convenience: register a JSON 200 response for any URL containing `match`. */
export function routeJson(
  match: Route['match'],
  body: unknown,
  method?: string
): void {
  route({ match, method, respond: { status: 200, body } });
}

/** Convenience: register an error response (default 401). */
export function routeError(
  match: Route['match'],
  status = 401,
  message = 'Unauthorized'
): void {
  route({ match, respond: { status, statusText: message, body: { message } } });
}

/** Build a ToolContext backed by a real TfsClient against the fake TFS. */
export function makeCtx(
  overrides: Partial<{ baseUrl: string; organization: string; token: string }> = {}
): ToolContext {
  const client = new TfsClient({
    baseUrl: 'http://tfs.test/tfs',
    organization: 'DefaultCollection',
    token: 'test-pat',
    ...overrides,
  });
  return { client };
}

/** First recorded call matching method + URL substring (undefined if none). */
export function findCall(method: string, urlSubstr: string): RecordedCall | undefined {
  return calls.find(
    (c) => c.method.toUpperCase() === method.toUpperCase() && c.url.includes(urlSubstr)
  );
}

/** Count recorded calls of a given method. */
export function countMethod(method: string): number {
  return calls.filter((c) => c.method.toUpperCase() === method.toUpperCase()).length;
}
