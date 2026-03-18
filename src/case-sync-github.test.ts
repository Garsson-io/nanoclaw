import { describe, test, expect } from 'vitest';

import {
  serializeMetadata,
  parseMetadata,
  type CaseMetadata,
} from './case-sync-github.js';

// INVARIANT: Metadata serialization round-trips correctly
// SUT: serializeMetadata, parseMetadata
describe('metadata serialization', () => {
  const fullMetadata: CaseMetadata = {
    case_id: 'case-1710700000-abc',
    case_name: '260317-1920-nir-b-booklet-butterfly',
    type: 'work',
    status: 'active',
    customer_name: 'Nir B.',
    customer_phone: '+972-50-1234567',
    customer_email: 'nir@example.com',
    customer_org: "Nir's Print Shop",
    initiator: 'nir-b',
    created_at: '2026-03-17T19:20:09Z',
    cost_usd: 0.42,
    time_spent_ms: 120000,
  };

  test('round-trips complete metadata', () => {
    const serialized = serializeMetadata(fullMetadata);
    const parsed = parseMetadata(serialized);

    expect(parsed).not.toBeNull();
    expect(parsed!.case_id).toBe(fullMetadata.case_id);
    expect(parsed!.case_name).toBe(fullMetadata.case_name);
    expect(parsed!.type).toBe(fullMetadata.type);
    expect(parsed!.status).toBe(fullMetadata.status);
    expect(parsed!.customer_name).toBe(fullMetadata.customer_name);
    expect(parsed!.customer_phone).toBe(fullMetadata.customer_phone);
    expect(parsed!.customer_email).toBe(fullMetadata.customer_email);
    expect(parsed!.customer_org).toBe(fullMetadata.customer_org);
    expect(parsed!.initiator).toBe(fullMetadata.initiator);
    expect(parsed!.created_at).toBe(fullMetadata.created_at);
    expect(parsed!.cost_usd).toBe(fullMetadata.cost_usd);
    expect(parsed!.time_spent_ms).toBe(fullMetadata.time_spent_ms);
  });

  test('omits empty/null/undefined fields', () => {
    const minimal: CaseMetadata = {
      case_id: 'case-123',
      case_name: 'test',
      type: 'dev',
      status: 'active',
      initiator: 'test',
      created_at: '2026-01-01T00:00:00Z',
      cost_usd: 0,
      time_spent_ms: 0,
    };

    const serialized = serializeMetadata(minimal);
    expect(serialized).not.toContain('customer_name');
    expect(serialized).not.toContain('customer_phone');
    expect(serialized).not.toContain('customer_email');
    expect(serialized).not.toContain('customer_org');
  });

  test('serialized format starts with HTML comment marker', () => {
    const serialized = serializeMetadata(fullMetadata);
    expect(serialized).toMatch(/^<!-- nanoclaw:v1/);
    expect(serialized).toMatch(/-->$/);
  });

  test('returns null when parsing body without metadata', () => {
    expect(parseMetadata('just some markdown')).toBeNull();
    expect(parseMetadata('')).toBeNull();
  });

  test('returns null when metadata block is incomplete', () => {
    expect(parseMetadata('<!-- nanoclaw:v1\ncase_id: test')).toBeNull();
  });

  test('parses metadata embedded in larger body', () => {
    const body = `Some preamble text

<!-- nanoclaw:v1
case_id: case-embedded
case_name: test-embedded
type: work
status: done
initiator: agent
created_at: 2026-01-01T00:00:00Z
cost_usd: 1.5
time_spent_ms: 60000
-->

## Issue description

More markdown here`;

    const parsed = parseMetadata(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.case_id).toBe('case-embedded');
    expect(parsed!.status).toBe('done');
    expect(parsed!.cost_usd).toBe(1.5);
  });

  test('handles numeric fields gracefully', () => {
    const body = `<!-- nanoclaw:v1
case_id: test
case_name: test
type: work
status: active
initiator: test
created_at: 2026-01-01T00:00:00Z
cost_usd: not-a-number
time_spent_ms: also-not
-->`;

    const parsed = parseMetadata(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.cost_usd).toBe(0);
    expect(parsed!.time_spent_ms).toBe(0);
  });
});
