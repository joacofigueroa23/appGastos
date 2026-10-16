import { ApiError } from './errors';
export function uuid(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, field + ' debe ser un UUID.');
  }
  return value;
}
export function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ApiError(400, field + ' es obligatorio y debe tener hasta ' + max + ' caracteres.');
  }
  return value.trim();
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Se requiere un objeto JSON.');
  return value as Record<string, unknown>;
}
