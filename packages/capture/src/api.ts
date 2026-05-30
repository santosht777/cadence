import type { Sample } from './types.js';

export interface CadenceClientOptions {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface SubmitAppRegistrationOptions {
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface AppRegistrationStatusOptions {
  apiBaseUrl: string;
  lookupToken: string;
  fetchImpl?: typeof fetch;
}

export interface AppRegistrationRequest {
  name: string;
  contact_email: string;
  slug?: string;
  allowed_origins?: readonly string[];
  use_case?: string;
}

export interface AppRegistration {
  readonly app_registration_id: string;
  readonly name: string;
  readonly slug: string;
  readonly contact_email: string;
  readonly allowed_origins: readonly string[];
  readonly use_case?: string | null;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly application_id?: string | null;
  readonly reviewed_at?: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface AppRegistrationResponse {
  readonly status: 'submitted';
  readonly registration: AppRegistration;
  readonly lookup_token: string;
}

export interface AppRegistrationStatusResponse {
  readonly status: 'ok';
  readonly registration: AppRegistration;
}

export interface EndUserMetadata {
  readonly [key: string]: unknown;
}

export interface PlatformEndUser {
  readonly end_user_id: string;
  readonly application_id: string;
  readonly external_user_id: string;
  readonly threshold?: number;
  readonly metadata?: EndUserMetadata;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface EnrollmentState {
  readonly enrolled: boolean;
  readonly enrollment_count: number;
  readonly enrollment_required: number;
  readonly enrollment_samples_needed: number;
}

export interface CreateEndUserRequest {
  external_user_id: string;
  threshold?: number;
  metadata?: EndUserMetadata;
}

export interface EndUserResponse extends EnrollmentState {
  readonly status: 'ok';
  readonly end_user: PlatformEndUser;
}

export interface EnrollRequest {
  external_user_id: string;
  raw_data: Sample | { keystrokes: readonly unknown[] } | readonly unknown[];
  source?: string;
  successful?: boolean;
  quality_score?: number;
  flags?: readonly string[];
}

export interface EnrollResponse extends EnrollmentState {
  readonly status: 'enrolled';
  readonly end_user_id: string;
  readonly external_user_id: string;
}

export interface ScoreRequest {
  external_user_id: string;
  raw_data: Sample | { keystrokes: readonly unknown[] } | readonly unknown[];
  threshold?: number;
  store_successful_sample?: boolean;
}

export interface ScoreResponse extends EnrollmentState {
  readonly status: 'ok';
  readonly score_request_id: string;
  readonly end_user_id: string;
  readonly external_user_id: string;
  readonly score: number | null;
  readonly confidence: number | null;
  readonly accepted: boolean;
  readonly match: boolean;
  readonly threshold: number;
  readonly reason: 'accepted' | 'low_confidence' | 'not_enrolled' | string;
  readonly score_duration_ms?: number;
}

export class CadenceApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'CadenceApiError';
    this.status = status;
    this.body = body;
  }
}

export class CadenceClient {
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CadenceClientOptions) {
    if (!options.apiBaseUrl) {
      throw new TypeError('CadenceClient: apiBaseUrl is required');
    }
    if (!options.apiKey) {
      throw new TypeError('CadenceClient: apiKey is required');
    }
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  createEndUser(request: CreateEndUserRequest): Promise<EndUserResponse> {
    return this.request('/v1/end-users', {
      method: 'POST',
      body: request
    });
  }

  getEndUser(externalUserId: string): Promise<EndUserResponse> {
    if (!externalUserId) {
      throw new TypeError('CadenceClient.getEndUser: externalUserId is required');
    }
    return this.request(`/v1/end-users/${encodeURIComponent(externalUserId)}`);
  }

  enroll(request: EnrollRequest): Promise<EnrollResponse> {
    return this.request('/v1/enroll', {
      method: 'POST',
      body: request
    });
  }

  score(request: ScoreRequest): Promise<ScoreResponse> {
    return this.request('/v1/score', {
      method: 'POST',
      body: request
    });
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new CadenceApiError(errorMessage(body, response.status), response.status, body);
    }
    return body as T;
  }
}

export function createCadenceClient(options: CadenceClientOptions): CadenceClient {
  return new CadenceClient(options);
}

export async function submitAppRegistration(
  options: SubmitAppRegistrationOptions,
  request: AppRegistrationRequest
): Promise<AppRegistrationResponse> {
  if (!options.apiBaseUrl) {
    throw new TypeError('submitAppRegistration: apiBaseUrl is required');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${options.apiBaseUrl.replace(/\/+$/, '')}/v1/app-registrations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    }
  );
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new CadenceApiError(errorMessage(body, response.status), response.status, body);
  }
  return body as AppRegistrationResponse;
}

export async function getAppRegistrationStatus(
  options: AppRegistrationStatusOptions,
  appRegistrationId: string
): Promise<AppRegistrationStatusResponse> {
  if (!options.apiBaseUrl) {
    throw new TypeError('getAppRegistrationStatus: apiBaseUrl is required');
  }
  if (!options.lookupToken) {
    throw new TypeError('getAppRegistrationStatus: lookupToken is required');
  }
  if (!appRegistrationId) {
    throw new TypeError('getAppRegistrationStatus: appRegistrationId is required');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${options.apiBaseUrl.replace(/\/+$/, '')}/v1/app-registrations/${encodeURIComponent(appRegistrationId)}/status`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.lookupToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new CadenceApiError(errorMessage(body, response.status), response.status, body);
  }
  return body as AppRegistrationStatusResponse;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, status: number): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'message' in body &&
    typeof (body as { message?: unknown }).message === 'string'
  ) {
    return (body as { message: string }).message;
  }
  return `Cadence API request failed with status ${status}`;
}
