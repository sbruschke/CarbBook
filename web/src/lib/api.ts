/** A non-2xx response from carbs-server, carrying its `{ error, message }` body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The request never got a response (offline, DNS failure, tunnel down). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  getBytes(path: string): Promise<ArrayBuffer>;
}

/** Same-origin JSON client; the session cookie travels automatically. */
export function createApi(fetchImpl: Fetch = (input, init) => fetch(input, init)): Api {
  async function send(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(path, { credentials: 'same-origin', ...init });
    } catch (error) {
      throw new NetworkError(error instanceof Error ? error.message : String(error));
    }
    if (response.ok) return response;
    let code = 'http_error';
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown; message?: unknown };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // Not JSON (e.g. a Cloudflare error page): keep the generic code and message.
    }
    throw new ApiError(response.status, code, message);
  }

  /** A 2xx response that isn't JSON (e.g. an HTML login/captive-portal page) is a server problem, not ours. */
  async function parseJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(response.status, 'non_json', `Expected JSON, got a non-JSON ${response.status} response`);
    }
  }

  return {
    async get<T>(path: string): Promise<T> {
      return parseJson<T>(await send(path, { method: 'GET' }));
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      const response = await send(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return parseJson<T>(response);
    },
    async getBytes(path: string): Promise<ArrayBuffer> {
      return (await send(path, { method: 'GET' })).arrayBuffer();
    },
  };
}
