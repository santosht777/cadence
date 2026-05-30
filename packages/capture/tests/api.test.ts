import { describe, expect, it, vi } from 'vitest';
import {
  CadenceApiError,
  createCadenceClient,
  getAppRegistrationStatus,
  submitAppRegistration
} from '../src/index.js';
import type { Sample } from '../src/types.js';

const sample: Sample = {
  session_id: 'session-1',
  field_id: 'password',
  session_start_ms: 1_700_000_000_000,
  events: [
    { type: 'down', code: 'KeyA', t: 0 },
    { type: 'up', code: 'KeyA', t: 80 }
  ],
  flags: [],
  untrusted_events: 0,
  env: {
    user_agent: 'test',
    timing_resolution_ms: 0.1
  },
  quality_score: 1,
  library_version: '0.1.0'
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('CadenceClient', () => {
  it('submits app registration requests without a bearer token', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: 'submitted',
        registration: {
          app_registration_id: 'registration-1',
          name: 'Partner App',
          slug: 'partner-app',
          contact_email: 'dev@partner.example',
          allowed_origins: ['https://partner.example'],
          status: 'pending'
        },
        lookup_token: 'reg_status_test'
      }, 201)
    );

    const result = await submitAppRegistration(
      {
        apiBaseUrl: 'https://api.example.test/',
        fetchImpl
      },
      {
        name: 'Partner App',
        contact_email: 'dev@partner.example',
        allowed_origins: ['https://partner.example']
      }
    );

    expect(result.registration.status).toBe('pending');
    expect(result.lookup_token).toBe('reg_status_test');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/v1/app-registrations',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Partner App',
          contact_email: 'dev@partner.example',
          allowed_origins: ['https://partner.example']
        })
      })
    );
  });

  it('fetches app registration status with a lookup token', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: 'ok',
        registration: {
          app_registration_id: 'registration-1',
          name: 'Partner App',
          slug: 'partner-app',
          contact_email: 'dev@partner.example',
          allowed_origins: ['https://partner.example'],
          status: 'approved',
          application_id: 'app-1'
        }
      })
    );

    const result = await getAppRegistrationStatus(
      {
        apiBaseUrl: 'https://api.example.test/',
        lookupToken: 'reg_status_test',
        fetchImpl
      },
      'registration/1'
    );

    expect(result.registration.status).toBe('approved');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/v1/app-registrations/registration%2F1/status',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer reg_status_test',
          'Content-Type': 'application/json'
        }
      })
    );
  });

  it('sends enroll requests with bearer authentication', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: 'enrolled',
        end_user_id: 'end-user-1',
        external_user_id: 'user-123',
        enrolled: false,
        enrollment_count: 1,
        enrollment_required: 5,
        enrollment_samples_needed: 4
      })
    );
    const client = createCadenceClient({
      apiBaseUrl: 'https://api.example.test/',
      apiKey: 'sk_live_test',
      fetchImpl
    });

    const result = await client.enroll({
      external_user_id: 'user-123',
      raw_data: sample,
      quality_score: sample.quality_score,
      flags: sample.flags
    });

    expect(result.enrollment_samples_needed).toBe(4);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/v1/enroll',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk_live_test',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          external_user_id: 'user-123',
          raw_data: sample,
          quality_score: sample.quality_score,
          flags: sample.flags
        })
      })
    );
  });

  it('encodes external user IDs when fetching enrollment state', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: 'ok',
        end_user: {
          end_user_id: 'end-user-1',
          application_id: 'app-1',
          external_user_id: 'user/123'
        },
        enrolled: true,
        enrollment_count: 5,
        enrollment_required: 5,
        enrollment_samples_needed: 0
      })
    );
    const client = createCadenceClient({
      apiBaseUrl: 'https://api.example.test',
      apiKey: 'sk_live_test',
      fetchImpl
    });

    await client.getEndUser('user/123');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/v1/end-users/user%2F123',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('throws CadenceApiError with response status and body', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ status: 'unauthorized', message: 'invalid API key' }, 401)
    );
    const client = createCadenceClient({
      apiBaseUrl: 'https://api.example.test',
      apiKey: 'bad',
      fetchImpl
    });

    await expect(
      client.score({ external_user_id: 'user-123', raw_data: sample })
    ).rejects.toMatchObject({
      name: 'CadenceApiError',
      status: 401,
      message: 'invalid API key'
    });

    try {
      await client.score({ external_user_id: 'user-123', raw_data: sample });
    } catch (error) {
      expect(error).toBeInstanceOf(CadenceApiError);
      expect((error as CadenceApiError).body).toEqual({
        status: 'unauthorized',
        message: 'invalid API key'
      });
    }
  });

  it('returns score analysis aliases from the typed client', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: 'ok',
        score_request_id: 'score-1',
        end_user_id: 'end-user-1',
        external_user_id: 'user-123',
        score: 0.91,
        confidence: 0.91,
        accepted: true,
        match: true,
        threshold: 0.5,
        reason: 'accepted',
        score_duration_ms: 14.2,
        enrolled: true,
        enrollment_count: 5,
        enrollment_required: 5,
        enrollment_samples_needed: 0
      })
    );
    const client = createCadenceClient({
      apiBaseUrl: 'https://api.example.test',
      apiKey: 'sk_live_test',
      fetchImpl
    });

    const result = await client.score({ external_user_id: 'user-123', raw_data: sample });

    expect(result.match).toBe(true);
    expect(result.confidence).toBe(0.91);
    expect(result.score_duration_ms).toBe(14.2);
  });
});
