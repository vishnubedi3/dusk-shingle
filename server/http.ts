/** Framework-neutral request/response shapes shared by the Vercel adapter and the dev server. */
export type ApiRequest = {
  method: string;
  path: string; // e.g. /api/me
  headers: Record<string, string | undefined>;
  body: unknown;
  ip: string;
  /** Query parameters, already decoded. Empty for requests without a query string. */
  query?: Record<string, string>;
};

export type ApiResponse = {
  status: number;
  body?: unknown;
  cookies?: string[];
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const json = (status: number, body?: unknown, cookies?: string[]): ApiResponse => ({ status, body, cookies });

export const MAX_BODY_BYTES = 100_000;
