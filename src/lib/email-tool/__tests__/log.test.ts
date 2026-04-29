import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '../log';

describe('log()', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    consoleSpy?.mockRestore();
  });

  it('emits a single JSON line to stdout per call', () => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('info', 'tick_start', { campaign_id: 'abc-123' });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const arg = consoleSpy.mock.calls[0][0] as string;
    // exactly one JSON line — no trailing newline, no concatenation
    expect(arg).not.toContain('\n');
    expect(() => JSON.parse(arg)).not.toThrow();
  });

  it('shape includes ts, level, event, component, and merged fields', () => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('info', 'tick_start', { campaign_id: 'abc-123', queue_count: 1200 });
    const json = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(json.level).toBe('info');
    expect(json.event).toBe('tick_start');
    expect(json.component).toBe('email-send');
    expect(json.campaign_id).toBe('abc-123');
    expect(json.queue_count).toBe(1200);
    // ts is an ISO-8601 timestamp
    expect(typeof json.ts).toBe('string');
    expect(json.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('handles no-fields case', () => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('warn', 'pool_low_water');
    const json = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(json.event).toBe('pool_low_water');
    expect(json.level).toBe('warn');
    expect(json.component).toBe('email-send');
  });

  it('user-supplied fields cannot override structural keys', () => {
    // The reserved keys (ts, level, event, component) should not be
    // overwritable from the fields argument — that would make logs
    // ambiguous. The structural fields win.
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('error', 'crash', {
      level: 'spoofed',
      event: 'spoofed',
      component: 'spoofed',
      ts: 'spoofed',
      stack: 'real-stack',
    } as Record<string, unknown>);
    const json = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(json.level).toBe('error');
    expect(json.event).toBe('crash');
    expect(json.component).toBe('email-send');
    expect(json.ts).not.toBe('spoofed');
    expect(json.stack).toBe('real-stack');
  });

  it('accepts the three documented levels', () => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('info', 'a');
    log('warn', 'b');
    log('error', 'c');
    expect(consoleSpy).toHaveBeenCalledTimes(3);
    const levels = consoleSpy.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string).level);
    expect(levels).toEqual(['info', 'warn', 'error']);
  });
});
