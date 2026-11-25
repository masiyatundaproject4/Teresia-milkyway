import { randomUUID } from 'node:crypto';

const REQUEST_ID = /^[a-zA-Z0-9._-]{8,128}$/;

export function requestId(request) {
  const supplied = request?.headers?.['x-request-id'] || request?.headers?.get?.('x-request-id');
  return typeof supplied === 'string' && REQUEST_ID.test(supplied) ? supplied : randomUUID();
}

export function logError(event, error, fields = {}) {
  console.error(JSON.stringify({
    level: 'error',
    event,
    ...fields,
    error: {
      name: String(error?.name || 'Error').slice(0, 80),
      message: String(error?.message || error || 'Unknown error').slice(0, 500),
      ...(error?.code ? { code: String(error.code).slice(0, 80) } : {}),
    },
  }));
}

export function logWarning(event, fields = {}) {
  console.warn(JSON.stringify({ level: 'warn', event, ...fields }));
}
