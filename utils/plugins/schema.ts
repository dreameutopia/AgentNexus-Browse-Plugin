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
    JSON.stringify(schema).length <= 32_768,
    'SCHEMA_LIMIT',
    'root: schema exceeds 32 KiB',
  );
  invariant(
    schema.type === 'object',
    'INVALID_SCHEMA',
    'root: top-level schema must declare type "object"',
  );
  let nodes = 0;
  function visit(s: any, depth: number, path: string) {
    invariant(
      s && typeof s === 'object' && !Array.isArray(s),
      'SCHEMA_LIMIT',
      `${path}: schema node must be an object`,
    );
    invariant(depth <= 12, 'SCHEMA_LIMIT', `${path}: nesting exceeds 12 levels`);
    invariant(++nodes <= 500, 'SCHEMA_LIMIT', 'too many schema nodes');
    for (const key of Object.keys(s))
      invariant(keywords.has(key), 'UNSUPPORTED_SCHEMA_KEYWORD', `${path}.${key}`);
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
        `${path}.type: ${String(s.type)}`,
      );
    if (s.required !== undefined)
      invariant(
        Array.isArray(s.required) &&
          s.required.length <= 100 &&
          s.required.every((k: unknown) => typeof k === 'string'),
        'INVALID_SCHEMA_REQUIRED',
        `${path}.required`,
      );
    if (s.additionalProperties !== undefined)
      invariant(
        typeof s.additionalProperties === 'boolean',
        'INVALID_SCHEMA_ADDITIONAL_PROPERTIES',
        `${path}.additionalProperties`,
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
          `${path}.${key}`,
        );
    if (s.enum !== undefined)
      invariant(
        Array.isArray(s.enum) && s.enum.length > 0 && s.enum.length <= 100,
        'INVALID_SCHEMA_ENUM',
        `${path}.enum`,
      );
    if (s.properties !== undefined) {
      invariant(
        s.properties &&
          typeof s.properties === 'object' &&
          !Array.isArray(s.properties),
        'INVALID_SCHEMA_PROPERTIES',
        `${path}.properties`,
      );
      for (const [key, child] of Object.entries(s.properties))
        visit(child, depth + 1, `${path}.properties.${key}`);
    }
    if (s.items !== undefined) visit(s.items, depth + 1, `${path}.items`);
    for (const key of ['anyOf', 'oneOf', 'allOf'])
      if (s[key] !== undefined) {
        invariant(
          Array.isArray(s[key]) && s[key].length > 0 && s[key].length <= 8,
          'SCHEMA_LIMIT',
          `${path}.${key}`,
        );
        s[key].forEach((child: unknown, index: number) =>
          visit(child, depth + 1, `${path}.${key}[${index}]`),
        );
      }
  }
  visit(schema, 0, 'root');
}
export function validateArguments(
  schema: Record<string, unknown>,
  value: unknown,
): void {
  invariant(JSON.stringify(value).length <= LIMITS.args, 'ARGUMENT_LIMIT');
  let budget = 50_000;
  let failure: string | undefined;
  const fail = (path: string, message: string): false => {
    failure ??= `${path}: ${message}`;
    return false;
  };
  function matches(s: any, v: any, path: string): boolean {
    invariant(--budget > 0, 'VALIDATION_BUDGET');
    const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    if (s.type) {
      const valid =
        s.type === 'integer' ? Number.isSafeInteger(v) : s.type === type;
      if (!valid) return fail(path, `expected ${s.type}, received ${type}`);
    }
    if (
      s.enum &&
      !s.enum.some((x: unknown) => canonicalize(x) === canonicalize(v))
    )
      return fail(path, 'value is not in enum');
    if (Object.hasOwn(s, 'const') && canonicalize(s.const) !== canonicalize(v))
      return fail(path, 'value does not match const');
    if (
      typeof v === 'number' &&
      (!Number.isFinite(v) ||
        (s.minimum !== undefined && v < s.minimum) ||
        (s.maximum !== undefined && v > s.maximum))
    )
      return fail(path, 'number is outside the allowed range');
    if (
      typeof v === 'string' &&
      ((s.minLength !== undefined && [...v].length < s.minLength) ||
        (s.maxLength !== undefined && [...v].length > s.maxLength))
    )
      return fail(path, 'string length is outside the allowed range');
    if (Array.isArray(v)) {
      if (
        (s.minItems !== undefined && v.length < s.minItems) ||
        (s.maxItems !== undefined && v.length > s.maxItems)
      )
        return fail(path, 'array length is outside the allowed range');
      if (
        s.items &&
        !v.every((x, index) => matches(s.items, x, `${path}[${index}]`))
      )
        return false;
    }
    if (v && type === 'object') {
      const missing = Array.isArray(s.required)
        ? (s.required.find((k: string) => !Object.hasOwn(v, k)) as
            | string
            | undefined)
        : undefined;
      if (missing) return fail(path, `missing required property "${missing}"`);
      for (const [k, x] of Object.entries(v)) {
        if (s.properties && Object.hasOwn(s.properties, k)) {
          if (!matches(s.properties[k], x, `${path}.${k}`)) return false;
        } else if (s.additionalProperties === false)
          return fail(`${path}.${k}`, 'additional properties are not allowed');
      }
    }
    if (s.anyOf && !s.anyOf.some((x: unknown) => matches(x, v, path)))
      return fail(path, 'value does not match any anyOf branch');
    if (s.oneOf) {
      const matched = s.oneOf.filter((x: unknown) =>
        matches(x, v, path),
      ).length;
      if (matched !== 1)
        return fail(
          path,
          `value matches ${matched} oneOf branches; exactly one is required`,
        );
    }
    if (s.allOf && !s.allOf.every((x: unknown) => matches(x, v, path)))
      return fail(path, 'value does not match every allOf branch');
    return true;
  }
  invariant(
    matches(schema, value, 'root'),
    'INVALID_ARGUMENTS',
    failure ?? 'arguments do not satisfy the tool schema',
  );
}
