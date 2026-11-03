/**
 * 版本化封套（Envelope）
 *
 * 每份持久化数据都包一层：
 *   { format, schema, rev, updatedAt, checksum, data }
 *
 * - format：识别「是不是本引擎写的」，避免误把别人的对象当数据
 * - schema：结构版本，向上兼容读（旧引擎读到更高版本 → frozen 只读保护）
 * - rev：单调递增修订号，用于快照排序与调试
 * - checksum：对 data 的稳定序列化校验和，抓「部分写入 / 磁盘损坏」
 *
 * 兼容历史数据：老版本插件存的是**裸对象**（无 format 字段）→ 解码为 legacy，
 * 不视为错误，首次写入时自动升级为封套格式。
 */

import { checksumOf } from './checksum';

/** 封套格式标记 */
export const ENGINE_FORMAT = 'agentnexus.config';

/** 当前引擎 schema 版本（结构升级时 +1，并在 migrations 中补迁移） */
export const ENGINE_SCHEMA = 1;

export interface Envelope<T = unknown> {
  format: typeof ENGINE_FORMAT;
  schema: number;
  rev: number;
  updatedAt: number;
  checksum: string;
  data: T;
}

export type DecodeFailReason =
  | 'empty'
  | 'not-object'
  | 'foreign'
  | 'schema-invalid'
  | 'schema-future'
  | 'checksum'
  | 'invalid-data';

export interface DecodeOk<T> {
  ok: true;
  data: T;
  schema: number;
  rev: number;
  updatedAt: number;
  /** true = 解到的是老版本裸数据（无封套） */
  legacy: boolean;
}

export interface DecodeFail {
  ok: false;
  reason: DecodeFailReason;
  detail?: string;
}

export type DecodeResult<T> = DecodeOk<T> | DecodeFail;

export interface DecodeOptions {
  /** 允许读取更高 schema 版本的数据（只读场景：frozen 保护） */
  allowSchemaFuture?: boolean;
  /** 允许校验和不匹配（仅用于最后一步抢救：宁可读到脏数据也不静默丢弃） */
  allowChecksumMismatch?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 计算 data 的校验和 */
export function computeDataChecksum(data: unknown): string {
  return checksumOf(data);
}

/** 构造封套 */
export function encodeEnvelope<T>(data: T, rev: number, updatedAt: number = Date.now()): Envelope<T> {
  return {
    format: ENGINE_FORMAT,
    schema: ENGINE_SCHEMA,
    rev,
    updatedAt,
    checksum: computeDataChecksum(data),
    data,
  };
}

/**
 * 解码封套
 *
 * 返回 ok=false 表示「这一份不能用」，由调用方按恢复阶梯尝试下一层副本；
 * 是否要抢救（allowChecksumMismatch）由调用方决定。
 */
export function decodeEnvelope<T>(raw: unknown, options: DecodeOptions = {}): DecodeResult<T> {
  if (raw === undefined || raw === null) return { ok: false, reason: 'empty' };
  if (!isPlainObject(raw)) return { ok: false, reason: 'not-object' };

  const marker = raw.format;
  if (marker === undefined) {
    // 老版本裸数据：没有 format 字段。仅当它看起来像普通配置对象时才接受。
    return { ok: true, data: raw as T, schema: 0, rev: 0, updatedAt: 0, legacy: true };
  }
  if (marker !== ENGINE_FORMAT) {
    return { ok: false, reason: 'foreign', detail: String(marker) };
  }

  const schema = raw.schema;
  if (typeof schema !== 'number' || !Number.isFinite(schema) || schema < 0) {
    return { ok: false, reason: 'schema-invalid', detail: String(schema) };
  }
  if (schema > ENGINE_SCHEMA && !options.allowSchemaFuture) {
    return { ok: false, reason: 'schema-future', detail: String(schema) };
  }
  if (raw.data === undefined) return { ok: false, reason: 'invalid-data' };

  const expected = typeof raw.checksum === 'string' ? raw.checksum : '';
  const actual = computeDataChecksum(raw.data);
  if (expected !== actual && !options.allowChecksumMismatch) {
    return { ok: false, reason: 'checksum', detail: `expected=${expected} actual=${actual}` };
  }

  return {
    ok: true,
    data: raw.data as T,
    schema,
    rev: numberOr(raw.rev, 0),
    updatedAt: numberOr(raw.updatedAt, 0),
    legacy: false,
  };
}
