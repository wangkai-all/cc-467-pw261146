/** 业务校验错误：携带可展示的原因，不导致进程崩溃 */
export class ValidationError extends Error {
  constructor(message, code = 'VALIDATION_ERROR', details = undefined) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
  }
}

export function notFound(message) {
  return new ValidationError(message, 'NOT_FOUND');
}

export function conflict(message, details = undefined) {
  return new ValidationError(message, 'CONFLICT', details);
}
