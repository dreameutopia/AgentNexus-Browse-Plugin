import { invariant, LIMITS } from './contracts';
import { canonicalize } from 'json-canonicalize';

// Intentionally interpreted, bounded subset: no code generation/eval under extension CSP.
const keywords = new Set([
  'type',
  'description',
  'title',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'default',
]);
export function checkSchema(schema: Record<string, unknown>): void {
  invariant(
    JSON.stringify(schema).length <= 32_768 && schema.type === 'object',
    'INVALID_SCHEMA',
  );
  let nodes = 0;
  function visit(s: any, depth: number) {
    invariant(
      s &&
        typeof s === 'object' &&
        !Array.isArray(s) &&
        depth <= 12 &&
        ++nodes <= 500,
      'SCHEMA_LIMIT',
    );
    for (const key of Object.keys(s))
      invariant(keywords.has(key), 'UNSUPPORTED_SCHEMA_KEYWORD', key);
    if (s.type !== undefined)
      invariant(
        [
          'object',
          'array',
          'string',
          'number',
          'integer',
          'boolean',
          'null',
        ].includes(s.type),
        'INVALID_SCHEMA_TYPE',
      );
    if (s.required !== undefined)
      invariant(
        Array.isArray(s.required) &&
          s.required.length <= 100 &&
          s.required.every((k: unknown) => typeof k === 'string'),
        'INVALID_SCHEMA_REQUIRED',
      );
    if (s.additionalProperties !== undefined)
      invariant(
        typeof s.additionalProperties === 'boolean',
        'INVALID_SCHEMA_ADDITIONAL_PROPERTIES',
      );
    for (const key of [
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
    ])
      if (s[key] !== undefined)
        invariant(
          typeof s[key] === 'number' && Number.isFinite(s[key]),
          'INVALID_SCHEMA_BOUND',
        );
    if (s.enum !== undefined)
      invariant(
        Array.isArray(s.enum) && s.enum.length > 0 && s.enum.length <= 100,
        'INVALID_SCHEMA_ENUM',
      );
    if (s.properties !== undefined) {
      invariant(
        s.properties &&
          typeof s.properties === 'object' &&
          !Array.isArray(s.properties),
        'INVALID_SCHEMA_PROPERTIES',
      );
      Object.values(s.properties).forEach((v) => visit(v, depth + 1));
    }
    if (s.items !== undefined) visit(s.items, depth + 1);
    for (const key of ['anyOf', 'oneOf', 'allOf'])
      if (s[key] !== undefined) {
        invariant(
          Array.isArray(s[key]) && s[key].length > 0 && s[key].length <= 8,
          'SCHEMA_LIMIT',
        );
        s[key].forEach((v: unknown) => visit(v, depth + 1));
      }
  }
  visit(schema, 0);
}
export function validateArguments(
  schema: Record<string, unknown>,
  value: unknown,
): void {
  invariant(JSON.stringify(value).length <= LIMITS.args, 'ARGUMENT_LIMIT');
  let budget = 50_000;
  function matches(s: any, v: any): boolean {
    invariant(--budget > 0, 'VALIDATION_BUDGET');
    const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    if (
      s.type &&
      (s.type === 'integer' ? !Number.isSafeInteger(v) : s.type !== type)
    )
      return false;
    if (
      s.enum &&
      !s.enum.some((x: unknown) => canonicalize(x) === canonicalize(v))
    )
      return false;
    if (Object.hasOwn(s, 'const') && canonicalize(s.const) !== canonicalize(v))
      return false;
    if (
      typeof v === 'number' &&
      (!Number.isFinite(v) ||
        (s.minimum !== undefined && v < s.minimum) ||
        (s.maximum !== undefined && v > s.maximum))
    )
      return false;
    if (
      typeof v === 'string' &&
      ((s.minLength !== undefined && [...v].length < s.minLength) ||
        (s.maxLength !== undefined && [...v].length > s.maxLength))
    )
      return false;
    if (Array.isArray(v)) {
      if (
        (s.minItems !== undefined && v.length < s.minItems) ||
        (s.maxItems !== undefined && v.length > s.maxItems)
      )
        return false;
      if (s.items && !v.every((x) => matches(s.items, x))) return false;
    }
    if (v && type === 'object') {
      if (s.required?.some((k: string) => !Object.hasOwn(v, k))) return false;
      for (const [k, x] of Object.entries(v)) {
        if (s.properties && Object.hasOwn(s.properties, k)) {
          if (!matches(s.properties[k], x)) return false;
        } else if (s.additionalProperties === false) return false;
      }
    }
    if (s.anyOf && !s.anyOf.some((x: unknown) => matches(x, v))) return false;
    if (s.oneOf && s.oneOf.filter((x: unknown) => matches(x, v)).length !== 1)
      return false;
    if (s.allOf && !s.allOf.every((x: unknown) => matches(x, v))) return false;
    return true;
  }
  invariant(matches(schema, value), 'INVALID_ARGUMENTS');
}
