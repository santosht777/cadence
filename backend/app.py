from flask import Flask, request, jsonify
from dotenv import load_dotenv
import os
import random
import hashlib
import json
import base64
import hmac
import re
import resend
from datetime import datetime, timedelta, timezone
from functools import wraps
import secrets
import uuid
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import hashes, serialization
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix
import statistics

load_dotenv()

from supabase import create_client

try:
    from .model_service import CadenceModelService
except ImportError:
    from model_service import CadenceModelService

app = Flask(__name__)
# Trust one level of X-Forwarded-For so the rate limiter sees the real
# client IP rather than the hosting platform's proxy address.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)
model_service = CadenceModelService()

# ---------------------------------------------------------------------------
# Rate limiting — applied per originating IP.
# /authenticate is the sensitive endpoint; limits are intentionally strict.
# Uses in-memory storage (fine for single-instance / demo). Swap storage_uri
# to "redis://..." for a multi-instance production deployment.
# ---------------------------------------------------------------------------
limiter = Limiter(
    get_remote_address,
    app=app,
    storage_uri="memory://",
    default_limits=[],
)

@app.errorhandler(429)
def ratelimit_handler(e):
    return jsonify({"status": "error", "message": "too many attempts — slow down and try again"}), 429


# How many consecutive wrong passwords before we lock the account and send
# an unlock email. Configurable via env so it can be tuned without a deploy.
FAILED_PASSWORD_THRESHOLD = int(os.getenv("CADENCE_PASSWORD_ATTEMPT_THRESHOLD", "5"))

# Demo mode: skips the Resend email and returns the freshly-generated
# OTP in the API response so testers without access to the inbox can
# still complete 2FA. Never enable in production.
DEMO_MODE = os.getenv("CADENCE_DEMO_MODE", "0").lower() in {"1", "true", "yes"}
RESEND_FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL", "team@cadence-capstone.us")

# CORS for the local dev frontend. Override with CADENCE_CORS_ORIGINS
# (comma-separated) when deploying behind a different origin.
_DEFAULT_CORS_ORIGINS = (
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:5173,http://127.0.0.1:5173"
)
ALLOWED_ORIGINS = {
    origin.strip()
    for origin in os.getenv("CADENCE_CORS_ORIGINS", _DEFAULT_CORS_ORIGINS).split(",")
    if origin.strip()
}


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin")
    if origin and origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return response


@app.route("/<path:_any>", methods=["OPTIONS"])
@app.route("/", methods=["OPTIONS"])
def cors_preflight(_any=None):
    return ("", 204)
REQUIRED_ENROLLMENT_SAMPLES = int(
    os.getenv("CADENCE_REQUIRED_ENROLLMENT_SAMPLES", "5")
)
ADMIN_TOKEN = os.getenv("CADENCE_ADMIN_TOKEN")
API_KEY_PREFIX_LENGTH = 18

# Two clients on purpose:
#   `supabase`      → service-role, used for ALL table reads/writes.
#   `supabase_auth` → service-role, used ONLY for auth.sign_up /
#                     auth.sign_in_with_password. After a successful
#                     sign-in the client's session switches to the
#                     newly-authenticated user, putting subsequent DB
#                     calls under that user's RLS context. Isolating
#                     auth on a separate client keeps `supabase` in
#                     service-role context for the rest of the request.
SUPABASE_URL = os.getenv("SUPABASE_URL").strip()
SUPABASE_KEY = os.getenv("SUPABASE_KEY").strip()
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
supabase_auth = create_client(SUPABASE_URL, SUPABASE_KEY)

# ---------------------------------------------------------------------------
# RSA keypair for encrypting keystroke events in transit.
# In production, set CADENCE_RSA_PRIVATE_KEY to a PEM-encoded private key so
# the same key survives restarts and can be rotated deliberately. In dev/demo
# mode a fresh ephemeral key is generated at startup — perfectly fine because
# the frontend fetches the public key fresh on every page load.
# ---------------------------------------------------------------------------
_raw_pem = os.getenv("CADENCE_RSA_PRIVATE_KEY")
if _raw_pem:
    _RSA_PRIVATE_KEY = serialization.load_pem_private_key(
        _raw_pem.strip().encode(), password=None
    )
else:
    _RSA_PRIVATE_KEY = rsa.generate_private_key(
        public_exponent=65537, key_size=2048
    )

_RSA_PUBLIC_KEY_PEM = _RSA_PRIVATE_KEY.public_key().public_bytes(
    serialization.Encoding.PEM,
    serialization.PublicFormat.SubjectPublicKeyInfo,
).decode()


def _supabase_sign_up(email, password):
    # Admin create skips the confirmation email Supabase would otherwise
    # send — important because the project's free-tier email rate limit
    # gets tripped quickly during demo signups. The created user is
    # marked already-confirmed so they can immediately sign in.
    return supabase.auth.admin.create_user({
        "email": email,
        "password": password,
        "email_confirm": True,
    })


def _supabase_sign_in(email, password):
    auth = supabase_auth.auth
    # helper handles Supabase sign in API differences
    try:
        return auth.sign_in_with_password({"email": email, "password": password})
    except TypeError:
        return auth.sign_in(email=email, password=password)


def error_response(message, status=400, code="error"):
    return jsonify({"status": code, "message": message}), status


def slugify(value):
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return slug or f"app-{secrets.token_hex(4)}"


def hash_api_key(api_key):
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def generate_api_key():
    return f"sk_live_{secrets.token_urlsafe(32)}"


def require_admin_if_configured():
    if not ADMIN_TOKEN:
        return None
    provided = request.headers.get("X-Cadence-Admin-Token", "")
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        provided = auth.split(" ", 1)[1].strip()
    if hmac.compare_digest(provided, ADMIN_TOKEN):
        return None
    return error_response("missing or invalid admin token", 401, "unauthorized")


def require_api_key(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.lower().startswith("bearer "):
            return error_response("missing bearer API key", 401, "unauthorized")

        api_key = auth.split(" ", 1)[1].strip()
        if not api_key:
            return error_response("missing bearer API key", 401, "unauthorized")

        prefix = api_key[:API_KEY_PREFIX_LENGTH]
        result = supabase.table("api_keys") \
            .select("api_key_id, application_id, key_prefix, key_hash, revoked_at") \
            .eq("key_prefix", prefix) \
            .execute()
        rows = result.data or []
        key_row = rows[0] if rows else None
        if (
            not key_row
            or key_row.get("revoked_at") is not None
            or not hmac.compare_digest(key_row.get("key_hash", ""), hash_api_key(api_key))
        ):
            return error_response("invalid API key", 401, "unauthorized")

        app_result = supabase.table("applications") \
            .select("*") \
            .eq("application_id", key_row["application_id"]) \
            .execute()
        app_rows = app_result.data or []
        if not app_rows:
            return error_response("API key application not found", 401, "unauthorized")

        supabase.table("api_keys") \
            .update({"last_used_at": datetime.now(timezone.utc).isoformat()}) \
            .eq("api_key_id", key_row["api_key_id"]) \
            .execute()
        request.cadence_api_key = key_row
        request.cadence_application = app_rows[0]
        return handler(*args, **kwargs)

    return wrapped


def get_json_body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def get_or_create_end_user(application_id, external_user_id, threshold=None, metadata=None):
    query = supabase.table("end_users") \
        .select("*") \
        .eq("application_id", application_id) \
        .eq("external_user_id", external_user_id) \
        .execute()
    rows = query.data or []
    if rows:
        return rows[0]

    payload = {
        "application_id": application_id,
        "external_user_id": external_user_id,
        "metadata": metadata or {},
    }
    if threshold is not None:
        payload["threshold"] = float(threshold)

    created = supabase.table("end_users").insert(payload).execute()
    return (created.data or [None])[0]


def count_platform_enrollment(end_user_id):
    result = supabase.table("typing_samples") \
        .select("typing_sample_id") \
        .eq("end_user_id", end_user_id) \
        .eq("successful", True) \
        .execute()
    return len(result.data or [])


def platform_enrollment_payload(end_user_id):
    enrollment_count = count_platform_enrollment(end_user_id)
    samples_needed = max(REQUIRED_ENROLLMENT_SAMPLES - enrollment_count, 0)
    return {
        "enrolled": samples_needed == 0,
        "enrollment_count": enrollment_count,
        "enrollment_required": REQUIRED_ENROLLMENT_SAMPLES,
        "enrollment_samples_needed": samples_needed,
    }


def fetch_platform_enrollment_samples(end_user_id):
    result = supabase.table("typing_samples") \
        .select("raw_data") \
        .eq("end_user_id", end_user_id) \
        .eq("successful", True) \
        .order("created_at", desc=True) \
        .limit(model_service.enrollment_limit) \
        .execute()
    samples = []
    for row in result.data or []:
        raw_data = row.get("raw_data")
        if raw_data:
            samples.append(model_service.raw_data_to_sample(raw_data))
    return samples


def count_successful_login_attempts(user_id):
    result = supabase.table("login_attempts") \
        .select("login_attempt_id") \
        .eq("user_id", user_id) \
        .eq("successful_login", True) \
        .execute()
    return len(result.data or [])


def enrollment_payload(enrollment_count):
    samples_needed = max(REQUIRED_ENROLLMENT_SAMPLES - enrollment_count, 0)
    return {
        "enrolled": samples_needed == 0,
        "enrollment_count": enrollment_count,
        "enrollment_required": REQUIRED_ENROLLMENT_SAMPLES,
        "enrollment_samples_needed": samples_needed,
    }


def require_2fa(user_id, username, login_attempt_id, enrollment_count, reason):
    supabase.table("user_profiles") \
        .update({"current_login_status": "pending 2fa"}) \
        .eq("user_id", user_id) \
        .execute()

    supabase.table("login_attempts") \
        .update({"two_fa_invoked": True}) \
        .eq("login_attempt_id", login_attempt_id) \
        .execute()

    # If sending the OTP fails (e.g. Resend rejects the recipient in
    # test mode), roll back the pending state so the user can retry
    # instead of getting wedged into "previous login still pending".
    try:
        otp = send_code(user_id, username, login_attempt_id)
    except Exception as exc:
        app.logger.exception("send_code failed; rolling back pending 2fa")
        supabase.table("user_profiles") \
            .update({"current_login_status": None}) \
            .eq("user_id", user_id) \
            .execute()
        supabase.table("_2fa") \
            .delete() \
            .eq("login_attempt_id", login_attempt_id) \
            .execute()
        return jsonify({
            "status": "error",
            "message": f"could not send 2FA email: {exc}",
        }), 502

    body = {
        "status": "2fa required",
        "login_attempt_id": login_attempt_id,
        "reason": reason,
        **enrollment_payload(enrollment_count),
    }
    if DEMO_MODE:
        body["demo_otp"] = otp
    return jsonify(body), 200


# health check endpoint
@app.get("/health")
def health():
    return {"status": "ok"}

# get model health endpoint
@app.get("/model/health")
def model_health():
    return jsonify(model_service.health())

@app.get("/public-key")
def public_key():
    # Vends the RSA public key so the frontend can encrypt keystroke events
    # before they leave the browser. The private key never leaves the server,
    # so a dev-tools observer only ever sees ciphertext — no raw timing values
    # to copy or tweak by a millisecond.
    return jsonify({"public_key": _RSA_PUBLIC_KEY_PEM}), 200


def _decrypt_events(raw_data):
    # Expects raw_data = { encrypted_key, iv, ciphertext } (all base64).
    # 1. Unwrap the per-request AES key with our RSA private key (OAEP-SHA256).
    # 2. Decrypt the events JSON with AES-256-GCM.
    # Returns the plaintext { events: [...] } dict, or raises on any failure.
    enc_key = base64.b64decode(raw_data["encrypted_key"])
    iv      = base64.b64decode(raw_data["iv"])
    ct      = base64.b64decode(raw_data["ciphertext"])

    aes_key = _RSA_PRIVATE_KEY.decrypt(
        enc_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None,
        ),
    )
    plaintext = AESGCM(aes_key).decrypt(iv, ct, None)
    return json.loads(plaintext)


@app.post("/v1/apps")
def create_platform_app():
    admin_error = require_admin_if_configured()
    if admin_error:
        return admin_error

    data = get_json_body()
    name = (data.get("name") or "").strip()
    if not name:
        return error_response("missing name")

    allowed_origins = data.get("allowed_origins") or []
    if not isinstance(allowed_origins, list) or not all(
        isinstance(origin, str) for origin in allowed_origins
    ):
        return error_response("allowed_origins must be a list of strings")

    payload = {
        "name": name,
        "slug": slugify(data.get("slug") or name),
        "allowed_origins": allowed_origins,
    }
    try:
        result = supabase.table("applications").insert(payload).execute()
    except Exception as exc:
        return error_response(str(exc), 400)

    return jsonify({"status": "created", "application": result.data[0]}), 201


@app.post("/v1/apps/<application_id>/api-keys")
def create_platform_api_key(application_id):
    admin_error = require_admin_if_configured()
    if admin_error:
        return admin_error

    app_result = supabase.table("applications") \
        .select("application_id") \
        .eq("application_id", application_id) \
        .execute()
    if not (app_result.data or []):
        return error_response("application not found", 404, "not_found")

    data = get_json_body()
    api_key = generate_api_key()
    payload = {
        "application_id": application_id,
        "name": (data.get("name") or "default").strip() or "default",
        "key_prefix": api_key[:API_KEY_PREFIX_LENGTH],
        "key_hash": hash_api_key(api_key),
    }
    result = supabase.table("api_keys").insert(payload).execute()
    key_row = result.data[0]
    return jsonify({
        "status": "created",
        "api_key": {
            "api_key_id": key_row["api_key_id"],
            "application_id": key_row["application_id"],
            "name": key_row["name"],
            "key_prefix": key_row["key_prefix"],
            "key": api_key,
        },
    }), 201


@app.post("/v1/end-users")
@require_api_key
def create_platform_end_user():
    data = get_json_body()
    external_user_id = (data.get("external_user_id") or "").strip()
    if not external_user_id:
        return error_response("missing external_user_id")

    metadata = data.get("metadata") or {}
    if not isinstance(metadata, dict):
        return error_response("metadata must be an object")

    end_user = get_or_create_end_user(
        request.cadence_application["application_id"],
        external_user_id,
        threshold=data.get("threshold"),
        metadata=metadata,
    )
    return jsonify({
        "status": "ok",
        "end_user": end_user,
        **platform_enrollment_payload(end_user["end_user_id"]),
    })


@app.get("/v1/end-users/<external_user_id>")
@require_api_key
def get_platform_end_user(external_user_id):
    result = supabase.table("end_users") \
        .select("*") \
        .eq("application_id", request.cadence_application["application_id"]) \
        .eq("external_user_id", external_user_id) \
        .execute()
    rows = result.data or []
    if not rows:
        return error_response("end user not found", 404, "not_found")

    end_user = rows[0]
    return jsonify({
        "status": "ok",
        "end_user": end_user,
        **platform_enrollment_payload(end_user["end_user_id"]),
    })


@app.post("/v1/enroll")
@require_api_key
def platform_enroll():
    data = get_json_body()
    external_user_id = (data.get("external_user_id") or "").strip()
    raw_data = data.get("raw_data")
    if not external_user_id:
        return error_response("missing external_user_id")
    if raw_data is None:
        return error_response("missing raw_data")

    try:
        model_service.raw_data_to_sample(raw_data)
    except Exception as exc:
        return error_response(f"invalid raw_data: {exc}")

    app_id = request.cadence_application["application_id"]
    end_user = get_or_create_end_user(app_id, external_user_id)
    flags = data.get("flags") or []
    if not isinstance(flags, list) or not all(isinstance(flag, str) for flag in flags):
        return error_response("flags must be a list of strings")

    payload = {
        "application_id": app_id,
        "end_user_id": end_user["end_user_id"],
        "raw_data": raw_data,
        "source": data.get("source") or "enrollment",
        "successful": bool(data.get("successful", True)),
        "quality_score": data.get("quality_score"),
        "flags": flags,
    }
    supabase.table("typing_samples").insert(payload).execute()
    return jsonify({
        "status": "enrolled",
        "end_user_id": end_user["end_user_id"],
        "external_user_id": external_user_id,
        **platform_enrollment_payload(end_user["end_user_id"]),
    }), 201


@app.post("/v1/score")
@require_api_key
def platform_score():
    data = get_json_body()
    external_user_id = (data.get("external_user_id") or "").strip()
    raw_data = data.get("raw_data")
    if not external_user_id:
        return error_response("missing external_user_id")
    if raw_data is None:
        return error_response("missing raw_data")

    app_id = request.cadence_application["application_id"]
    end_user = get_or_create_end_user(app_id, external_user_id)
    enrollment = platform_enrollment_payload(end_user["end_user_id"])
    threshold = float(data.get("threshold") or end_user.get("threshold") or 0.5)

    score = None
    accepted = False
    reason = None
    if not enrollment["enrolled"]:
        reason = "not_enrolled"
    else:
        try:
            current_sample = model_service.raw_data_to_sample(raw_data)
            enrollment_samples = fetch_platform_enrollment_samples(end_user["end_user_id"])
            score = model_service.score_against_enrollment(current_sample, enrollment_samples)
            accepted = score >= threshold
            reason = "accepted" if accepted else "low_confidence"
        except Exception as exc:
            app.logger.exception("platform model scoring failed")
            reason = f"scoring_failed: {exc}"

    request_payload = {
        "application_id": app_id,
        "end_user_id": end_user["end_user_id"],
        "external_user_id": external_user_id,
        "raw_data": raw_data,
        "score": score,
        "threshold": threshold,
        "accepted": accepted,
        "enrolled": enrollment["enrolled"],
        "enrollment_count": enrollment["enrollment_count"],
        "enrollment_required": enrollment["enrollment_required"],
        "reason": reason,
    }
    score_result = supabase.table("score_requests").insert(request_payload).execute()

    if accepted and data.get("store_successful_sample", False):
        supabase.table("typing_samples").insert({
            "application_id": app_id,
            "end_user_id": end_user["end_user_id"],
            "raw_data": raw_data,
            "source": "score",
            "successful": True,
            "confidence_score": score,
        }).execute()

    return jsonify({
        "status": "ok",
        "score_request_id": score_result.data[0]["score_request_id"],
        "end_user_id": end_user["end_user_id"],
        "external_user_id": external_user_id,
        "score": score,
        "accepted": accepted,
        "threshold": threshold,
        "reason": reason,
        **enrollment,
    })


# user signup endpoint
# register a new account through Supabase and add a local profile
@app.post("/signup")
def signup():
    data = request.json
    email = data.get("email")
    password = data.get("password")
    username = data.get("username")

    # error handling
    if not email:
        return jsonify({"status": "error", "message": "missing email"}), 400
    if not password:
        return jsonify({"status": "error", "message": "missing password"}), 400
    if len(password) < 8:
        return jsonify({"status": "error", "message": "password must be at least 8 characters"}), 400
    if not username:
        return jsonify({"status": "error", "message": "missing username"}), 400
    if username.lower() in password.lower():
        return jsonify({"status": "error", "message": "password must not contain your username"}), 400

    # check if username already exists
    existing_user = supabase.table("user_profiles") \
        .select("username") \
        .eq("username", username) \
        .execute()
    
    if existing_user.data:
        return jsonify({"status": "error", "message": "username already exists"}), 400

    try:
        sign_up_result = _supabase_sign_up(email, password)
    except Exception as exc:
        return jsonify({"status": "error", "message": str(exc)}), 400

    print("SIGN UP RESULT:", sign_up_result)
    sign_up_error = None
    sign_up_user = None
    if isinstance(sign_up_result, dict):
        sign_up_error = sign_up_result.get("error")
        sign_up_user = sign_up_result.get("user")
    else:
        sign_up_error = getattr(sign_up_result, "error", None)
        sign_up_user = getattr(sign_up_result, "user", None)

    if sign_up_error:
        return jsonify({"status": "error", "message": str(sign_up_error)}), 400

    user_id = None
    if isinstance(sign_up_user, dict):
        user_id = sign_up_user.get("id")
    else:
        user_id = getattr(sign_up_user, "id", None)

    if not user_id:
        return jsonify({"status": "error", "message": "signup did not return user id"}), 400

    print({
        "user_id": user_id,
        "username": username,
        "email": email,
        "threshold": 0.5,
        "current_login_status": None,
        "number_login_attempts": 0
    })
    # create local user_profiles row for biometric login data
    supabase.table("user_profiles").insert({
        "user_id": user_id,
        "username": username,
        "email": email,
        "threshold": 0.5,
        "current_login_status": None,
        "number_login_attempts": 0
    }).execute()

    return jsonify({"status": "signup_success", "user_id": user_id}), 200


# MAIN ENDPOINT 1: client calls with username/password and keystroke data.
# This endpoint authenticates user credentials through Supabase first,
# then applies biometric scoring and optional 2FA if the score is too low.
@app.post("/authenticate")
@limiter.limit("10 per minute; 50 per hour")
def authenticate():
    data = request.json
    username = data.get("username")
    password = data.get("password")
    raw_data = data.get("raw_data")
    is_mobile = bool(data.get("is_mobile"))

    # basic error handling 
    if not username:
        return jsonify({"status": "error", "message": "missing username"}), 400

    if not password:
        return jsonify({"status": "error", "message": "missing password"}), 400

    if raw_data is None:
        return jsonify({"status": "error", "message": "missing raw_data"}), 400

    # Decrypt the keystroke payload. The frontend always sends an encrypted
    # envelope; if decryption fails the payload was tampered with or malformed.
    try:
        raw_data = _decrypt_events(raw_data)
    except Exception:
        return jsonify({"status": "error", "message": "invalid keystroke payload"}), 400

    # Reject suspiciously uniform or impossibly fast keystroke sequences.
    # Matches the same message as the paste check so automated tooling gets
    # no signal about which specific heuristic was triggered.
    if _is_scripted_typing(raw_data):
        return jsonify({"status": "error", "message": "please type your password manually"}), 400

    # query user_profiles table to check user exists and get email for Supabase auth
    user = supabase.table("user_profiles") \
        .select("*") \
        .eq("username", username) \
        .execute()

    # if user not found
    if not user.data:
        return jsonify({"status": "user not found"}), 200

    # check current login status
    user_profile = user.data[0]
    user_id = user_profile.get("user_id")
    current_login_status = user_profile.get("current_login_status")
    
    # ensure user_id exists (required for RLS and data integrity)
    if not user_id:
        return jsonify({"status": "error", "message": "user profile incomplete - missing user_id"}), 400
    
    # Block states that should not start a new authentication attempt.
    # A real logout clears "logged in" back to null.
    if current_login_status == "pending 2fa":
        return jsonify({"status": "pending 2fa"}), 200
    elif current_login_status == "locked":
        return jsonify({"status": "account is locked"}), 200
    elif current_login_status == "password_locked":
        # Account is locked due to too many wrong passwords. The unlock code
        # was already sent when the threshold was hit; just tell the client.
        return jsonify({"status": "password_locked"}), 200
    elif current_login_status == "logged in":
        return jsonify({"status": "logged in"}), 200

    # verify username/password against Supabase auth
    email = user_profile.get("email")
    try:
        sign_in_result = _supabase_sign_in(email, password)
    except Exception:
        return jsonify({"status": "error", "message": "invalid credentials"}), 401

    sign_in_error = None
    if isinstance(sign_in_result, dict):
        sign_in_error = sign_in_result.get("error")
    else:
        sign_in_error = getattr(sign_in_result, "error", None)

    if sign_in_error:
        # Wrong password: increment the failure counter and, if the threshold
        # is reached, lock the account and email an unlock code to the owner.
        lock_info = _handle_failed_password(
            user_id, username,
            user_profile.get("failed_password_attempts", 0),
        )
        if lock_info:
            body = {"status": "password_locked", "login_attempt_id": lock_info["login_attempt_id"]}
            if DEMO_MODE and lock_info.get("demo_otp"):
                body["demo_otp"] = lock_info["demo_otp"]
            return jsonify(body), 200
        return jsonify({"status": "error", "message": "invalid credentials"}), 401

    # Reject replayed keystroke payloads. We compute the hash after cred
    # verification intentionally — returning this error to an unauthenticated
    # caller would confirm that a given username has prior login attempts.
    events_hash = _hash_events(raw_data)
    if events_hash and _is_replayed_payload(user_id, events_hash):
        return jsonify({"status": "error", "message": "duplicate keystroke payload — please retype your password"}), 400

    # create new login attempt w user info
    enrollment_count = count_successful_login_attempts(user_id)
    login_attempt_id = create_login_attempt(supabase, user_id, username, raw_data, events_hash=events_hash)
    if login_attempt_id == None:
        return jsonify({"status": "can't verify login"}), 200

    if enrollment_count < REQUIRED_ENROLLMENT_SAMPLES:
        return require_2fa(
            user_id,
            username,
            login_attempt_id,
            enrollment_count,
            "enrollment_required",
        )

    # Biometric model is trained on desktop typing — skip scoring on mobile
    # and require 2FA directly so the user isn't falsely rejected.
    if is_mobile:
        return require_2fa(
            user_id,
            username,
            login_attempt_id,
            enrollment_count,
            "mobile_device",
        )

    # get the score from ML engine 
    score = get_score(username, raw_data, login_attempt_id)
    print(score)
    
    # if no score available, treat as low confidence and trigger 2FA
    if score == None:
        score = 0.0  # treat as failed biometric check
    
    # store ml confidence score in login attempt table
    supabase.table("login_attempts") \
        .update({"confidence_score": score}) \
        .eq("login_attempt_id", login_attempt_id) \
        .execute()
    
    # get user's threshold 
    threshold_result = supabase.table("user_profiles") \
                .select("threshold") \
                .eq("user_id", user_id) \
                .execute()
    threshold = threshold_result.data[0]["threshold"]

    # check it
    if (score >= threshold):
        enrollment_count += 1
        supabase.table("login_attempts") \
            .update({"successful_login": True}) \
            .eq("login_attempt_id", login_attempt_id) \
            .execute()

        # mark as logged in and clear any lingering failure counter
        supabase.table("user_profiles") \
            .update({"current_login_status": "logged in", "failed_password_attempts": 0}) \
            .eq("user_id", user_id) \
            .execute()
            
        return jsonify({
            "status": "accepted",
            **enrollment_payload(enrollment_count),
        }), 200
    else:
        return require_2fa(
            user_id,
            username,
            login_attempt_id,
            enrollment_count,
            "low_confidence",
        )


@app.post("/logout")
def logout():
    data = request.json or {}
    username = data.get("username")

    if not username:
        return jsonify({"status": "error", "message": "missing username"}), 400

    user = supabase.table("user_profiles") \
        .select("user_id") \
        .eq("username", username) \
        .execute()

    if not user.data:
        return jsonify({"status": "user not found"}), 200

    supabase.table("user_profiles") \
        .update({"current_login_status": None}) \
        .eq("username", username) \
        .execute()

    return jsonify({"status": "logged out"}), 200


# main endpoint 2: after code is sent to user's email, client gets one-time code from user. 
# this method verifies it against the OTP hash that was generated and stored in _2fa challenges table in supabase. 
@app.post("/code_verification")
def code_verification():
    data = request.json
    username = data.get("username")
    code = data.get("code")
    login_attempt_id = data.get("login_attempt_id")

    # error handling 
    if not username:
        return jsonify({"status": "error", "message": "missing username"}), 400

    if not code:
        return jsonify({"status": "error", "message": "missing code"}), 400

    if not login_attempt_id:
        return jsonify({"status": "error", "message": "missing login_attempt_id"}), 400

    # Get user_id from login_attempts table using login_attempt_id
    login_attempt_result = supabase.table("login_attempts") \
        .select("user_id") \
        .eq("login_attempt_id", login_attempt_id) \
        .execute()

    if not login_attempt_result.data:
        return jsonify({"status": "rejected", "message": "invalid attempt"}), 200

    user_id = login_attempt_result.data[0].get("user_id")

    # query _2fa table by login_attempt_id (user_id also available for consistency check)
    result = supabase.table("_2fa") \
        .select("*") \
        .eq("login_attempt_id", login_attempt_id) \
        .execute()

    if not result.data:
        return jsonify({"status": "rejected", "message": "invalid attempt"}), 200

    entry = result.data[0]
    attempt_count = entry.get("attempt_count", 0)

    # check if max attempts exceeded
    if attempt_count >= 3:
        # mark account as locked
        supabase.table("user_profiles") \
            .update({"current_login_status": "locked"}) \
            .eq("user_id", user_id) \
            .execute()
        return jsonify({"status": "rejected", "message": "max attempts exceeded"}), 200

    # hash the provided code and check against stored hash
    code_hash = hashlib.sha256(code.encode()).hexdigest()
    stored_hash = entry.get("otp_hash")

    if code_hash != stored_hash:
        # increment attempt count only on wrong code
        supabase.table("_2fa") \
            .update({"attempt_count": attempt_count + 1}) \
            .eq("login_attempt_id", login_attempt_id) \
            .execute()
        return jsonify({"status": "rejected"}), 200  
    
    # check for expiration
    expires_at = entry.get("expires_at")
    
    if expires_at:
        expires_at = datetime.fromisoformat(expires_at)
        now = datetime.now(timezone.utc)

        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)

        if now > expires_at:
            return jsonify({"status": "rejected", "message": "expired"}), 200

    # delete the login attempt from 2fa table so code isn't reusable
    supabase.table("_2fa").delete().eq("login_attempt_id", login_attempt_id).execute()

    # Check if this verification is unlocking a brute-forced account rather
    # than completing a normal 2FA login. In the unlock flow the original
    # password was never correct, so we must not log the user in or count
    # this as an enrollment sample — we just clear the lock and let them
    # try again with their real password.
    profile_result = supabase.table("user_profiles") \
        .select("current_login_status") \
        .eq("user_id", user_id) \
        .single() \
        .execute()
    is_unlock = (profile_result.data or {}).get("current_login_status") == "password_locked"

    if is_unlock:
        supabase.table("user_profiles") \
            .update({"current_login_status": None, "failed_password_attempts": 0}) \
            .eq("user_id", user_id) \
            .execute()
        return jsonify({"status": "unlocked"}), 200

    # Normal 2FA success: mark the login attempt as successful and log in.
    supabase.table("login_attempts") \
        .update({"successful_login": True}) \
        .eq("login_attempt_id", login_attempt_id) \
        .execute()

    enrollment_count = count_successful_login_attempts(user_id)
    user_status = "logged in" if enrollment_count >= REQUIRED_ENROLLMENT_SAMPLES else None

    # Enrollment attempts stay login-capable until enough samples are collected.
    # Also clear any stale failure counter on successful authentication.
    supabase.table("user_profiles") \
        .update({"current_login_status": user_status, "failed_password_attempts": 0}) \
        .eq("user_id", user_id) \
        .execute()

    return jsonify({
        "status": "accepted",
        **enrollment_payload(enrollment_count),
    }), 200

# resend 2fa code endpoint
@app.post("/resend_code")
def resend_code():
    data = request.json
    username = data.get("username")
    login_attempt_id = data.get("login_attempt_id")

    # error handling
    if not username:
        return jsonify({"status": "error", "message": "missing username"}), 400

    if not login_attempt_id:
        return jsonify({"status": "error", "message": "missing login_attempt_id"}), 400

    # Get user_id from login_attempts table
    login_attempt_result = supabase.table("login_attempts") \
        .select("user_id") \
        .eq("login_attempt_id", login_attempt_id) \
        .execute()

    if not login_attempt_result.data:
        return jsonify({"status": "invalid attempt"}), 200

    user_id = login_attempt_result.data[0].get("user_id")

    # find the pending 2fa attempt for this login
    result = supabase.table("_2fa") \
        .select("*") \
        .eq("login_attempt_id", login_attempt_id) \
        .execute()

    if not result.data:
        return jsonify({"status": "invalid attempt"}), 200

    # generate new OTP
    otp = str(random.randint(100000, 999999))
    otp_hash = hashlib.sha256(otp.encode()).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)

    # update the 2fa record with new code
    supabase.table("_2fa") \
        .update({
            "otp_hash": otp_hash,
            "expires_at": expires_at.isoformat(),
            "attempt_count": 0
        }) \
        .eq("login_attempt_id", login_attempt_id) \
        .execute()

    # get email from user_profiles table
    email_result = supabase.table("user_profiles") \
        .select("email") \
        .eq("user_id", user_id) \
        .execute()
    email = email_result.data[0]["email"]

    if DEMO_MODE:
        app.logger.warning("[DEMO_MODE] resent OTP for %s (%s): %s", username, email, otp)
        return jsonify({"status": "code sent", "demo_otp": otp}), 200

    resend.api_key = os.getenv("RESEND_KEY")
    resend.Emails.send({
        "from": RESEND_FROM_EMAIL,
        "to": email,
        "subject": "Verification Code",
        "html": f"<p>Your one-time code is: {otp}</p>"
    })

    return jsonify({"status": "code sent"}), 200

# ---------------------------------------------------------------------------
# Brute-force protection helpers
# ---------------------------------------------------------------------------

def _handle_failed_password(user_id, username, current_failures):
    # Increment the consecutive wrong-password counter.
    # If the threshold is reached, send an unlock code and set the account to
    # "password_locked" so no further login attempts can proceed until the user
    # verifies their identity via email. Returns a dict with the unlock
    # login_attempt_id and (in demo mode) the OTP if the threshold was just
    # hit, otherwise returns None.
    new_count = current_failures + 1

    if new_count < FAILED_PASSWORD_THRESHOLD:
        supabase.table("user_profiles") \
            .update({"failed_password_attempts": new_count}) \
            .eq("user_id", user_id) \
            .execute()
        return None

    # Threshold reached. Create a minimal login_attempt to anchor the OTP
    # record (send_code requires a login_attempt_id with a matching row),
    # then send the unlock code. If sending fails we leave the account
    # unlocked rather than stranding the user with no way to recover.
    unlock_attempt_id = create_login_attempt(supabase, user_id, username, {})
    try:
        otp = send_code(user_id, username, unlock_attempt_id)
    except Exception:
        app.logger.exception("send_code failed during password-lock for %s", username)
        return None

    supabase.table("user_profiles") \
        .update({
            "failed_password_attempts": new_count,
            "current_login_status": "password_locked",
        }) \
        .eq("user_id", user_id) \
        .execute()

    return {
        "login_attempt_id": unlock_attempt_id,
        "demo_otp": otp if DEMO_MODE else None,
    }


# ---------------------------------------------------------------------------
# Scripted-typing detection
# ---------------------------------------------------------------------------

# Thresholds derived from human typing research and the specific 10ms-apart
# script the team observed. Configurable via env so they can be tuned without
# a redeploy if legitimate users with unusual typing styles are affected.
_MIN_MEAN_INTERVAL_MS  = float(os.getenv("CADENCE_MIN_MEAN_INTERVAL_MS",  "30"))
_MIN_STDDEV_INTERVAL_MS = float(os.getenv("CADENCE_MIN_STDDEV_INTERVAL_MS", "8"))

def _is_scripted_typing(raw_data):
    # Extract timestamps of keydown events only (down-to-down intervals are
    # the standard measure of typing speed and rhythm).
    events = (raw_data or {}).get("events") or []
    down_times = [e["t"] for e in events if e.get("type") == "down"]

    # Need at least 3 intervals to compute a meaningful standard deviation.
    if len(down_times) < 4:
        return False

    intervals = [down_times[i] - down_times[i - 1] for i in range(1, len(down_times))]

    mean_ms   = statistics.mean(intervals)
    stddev_ms = statistics.pstdev(intervals)  # population stdev — no sampling assumption

    # A real human cannot sustain sub-30ms intervals, and no human produces
    # near-zero variance across all keystrokes. Either condition alone is
    # sufficient to flag the session as automated.
    return mean_ms < _MIN_MEAN_INTERVAL_MS or stddev_ms < _MIN_STDDEV_INTERVAL_MS


# ---------------------------------------------------------------------------
# Replay-detection helpers
# ---------------------------------------------------------------------------

def _hash_events(raw_data):
    # Canonicalize the events array (sort_keys so key ordering can't create
    # two different hashes for the same payload) and return its SHA-256 digest.
    # Returns None when there are no events so callers can skip the DB check.
    events = (raw_data or {}).get("events") or []
    if not events:
        return None
    canonical = json.dumps(events, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _is_replayed_payload(user_id, events_hash):
    # An exact payload match within 24 hours is treated as a replay.
    # 24 h is wide enough to cover an attacker who captures all 5 enrollment
    # logins in one session and immediately tries to reuse them, while being
    # narrow enough not to bother legitimate users who might return the next day
    # (and whose live capture will differ by at least a few milliseconds anyway).
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    result = (
        supabase.table("login_attempts")
        .select("login_attempt_id")
        .eq("user_id", user_id)
        .eq("events_hash", events_hash)
        .gte("created_at", cutoff)
        .limit(1)
        .execute()
    )
    return bool(result.data)


# create new login attempt in DB, return login attempt id
def create_login_attempt(supabase, user_id, username, raw_data, events_hash=None):
    login_attempt_id = str(uuid.uuid4())
     # 1. fetch profile
    profile = (
        supabase
        .table("user_profiles")
        .select("number_login_attempts")
        .eq("user_id", user_id)
        .single()
        .execute()
    )

    current_count = profile.data["number_login_attempts"] or 0
    login_number = current_count + 1

    # 2. create login attempt row
    new_attempt = {
        "login_attempt_id": login_attempt_id,
        "user_id": user_id,
        "username": username,
        "login_number": login_number,
        "two_fa_invoked": False,
        "successful_login": None,
        "confidence_score": None,
        "raw_data": raw_data or {},
        "events_hash": events_hash,
    }

    # 3. insert into login_attempts
    supabase.table("login_attempts").insert(new_attempt).execute()

    # 4. update user profile counter
    supabase.table("user_profiles") \
        .update({"number_login_attempts": login_number}) \
        .eq("user_id", user_id) \
        .execute()

    return login_attempt_id

# call ML engine and return the score given
def get_score(username, raw_data, login_attempt_id=None):
    return model_service.score_login_attempt(
        supabase,
        username,
        raw_data,
        login_attempt_id=login_attempt_id,
    )

# generate otp hash, send code to user's email. Returns the plaintext
# OTP so the caller can surface it in demo mode.
def send_code(user_id, username, login_attempt_id):
    email_result = supabase.table("user_profiles") \
        .select("email") \
        .eq("user_id", user_id) \
        .execute()
    email = email_result.data[0]["email"]

    otp = str(random.randint(100000, 999999))
    otp_hash = hashlib.sha256(otp.encode()).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)

    # insert the 2fa attempt
    supabase.table("_2fa") \
        .insert({
            "login_attempt_id": login_attempt_id,
            "user_id": user_id,
            "username": username,
            "otp_hash": otp_hash,
            "expires_at": expires_at.isoformat(),
            "attempt_count": 0
        }) \
        .execute()

    if DEMO_MODE:
        app.logger.warning("[DEMO_MODE] OTP for %s (%s): %s", username, email, otp)
        return otp

    resend.api_key = os.getenv("RESEND_KEY")
    resend.Emails.send({
        "from": RESEND_FROM_EMAIL,
        "to": email,
        "subject": "Verification Code",
        "html": f"<p>Your one-time code is: {otp}</p>"
    })
    return otp

    

if __name__ == "__main__":
    app.run()
