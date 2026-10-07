// Every failure leaves the API as { error: { code, message, details? } } with a real
// HTTP status. A failed request never returns 200.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'bad_request', message, details)
export const unauthorized = (message = 'Sign in or send an API key.') => new ApiError(401, 'unauthorized', message)
export const forbidden = (message = 'Not allowed.', details?: unknown) => new ApiError(403, 'forbidden', message, details)
export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found.`)
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details)
