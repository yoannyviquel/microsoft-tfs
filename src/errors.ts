export class TfsError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly responseBody: string;

  constructor(operation: string, status: number, message: string, responseBody: string) {
    super(`Microsoft TFS error during ${operation} (${status}): ${message}`);
    this.name = 'TfsError';
    this.operation = operation;
    this.status = status;
    this.responseBody = responseBody;
  }
}
