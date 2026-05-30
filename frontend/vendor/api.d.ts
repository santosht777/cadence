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
    raw_data: Sample | {
        keystrokes: readonly unknown[];
    } | readonly unknown[];
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
    raw_data: Sample | {
        keystrokes: readonly unknown[];
    } | readonly unknown[];
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
export declare class CadenceApiError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(message: string, status: number, body: unknown);
}
export declare class CadenceClient {
    private readonly apiBaseUrl;
    private readonly apiKey;
    private readonly fetchImpl;
    constructor(options: CadenceClientOptions);
    createEndUser(request: CreateEndUserRequest): Promise<EndUserResponse>;
    getEndUser(externalUserId: string): Promise<EndUserResponse>;
    enroll(request: EnrollRequest): Promise<EnrollResponse>;
    score(request: ScoreRequest): Promise<ScoreResponse>;
    private request;
}
export declare function createCadenceClient(options: CadenceClientOptions): CadenceClient;
export declare function submitAppRegistration(options: SubmitAppRegistrationOptions, request: AppRegistrationRequest): Promise<AppRegistrationResponse>;
export declare function getAppRegistrationStatus(options: AppRegistrationStatusOptions, appRegistrationId: string): Promise<AppRegistrationStatusResponse>;
