#!/usr/bin/env python3
"""Smoke-test the deployed Cadence platform API end-to-end."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


def sample_payload() -> dict[str, list[dict[str, float]]]:
    return {
        "keystrokes": [
            {
                "hold_time": 78.0 + (index % 4),
                "flight_time": 38.0 + (index % 3),
                "down_down": 116.0 + (index % 5),
            }
            for index in range(12)
        ]
    }


def request_json(
    api_base: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    bearer_token: str | None = None,
    origin: str | None = None,
    expected: tuple[int, ...] = (200,),
) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"
    if origin:
        headers["Origin"] = origin

    request = Request(
        f"{api_base.rstrip('/')}{path}",
        data=data,
        method=method,
        headers=headers,
    )
    try:
        with urlopen(request, timeout=30) as response:
            payload = response.read().decode("utf-8")
            parsed = json.loads(payload) if payload else {}
            if response.status not in expected:
                raise SystemExit(
                    f"{method} {path} returned {response.status}, expected {expected}: "
                    f"{json.dumps(parsed, sort_keys=True)}"
                )
            return parsed
    except HTTPError as exc:
        payload = exc.read().decode("utf-8")
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            parsed = {"message": payload or exc.reason}
        raise SystemExit(
            f"{method} {path} failed with {exc.code}: {json.dumps(parsed, sort_keys=True)}"
        ) from exc
    except URLError as exc:
        raise SystemExit(f"{method} {path} connection failed: {exc.reason}") from exc


def require(value: Any, message: str) -> Any:
    if not value:
        raise SystemExit(message)
    return value


def assert_has_keys(payload: dict[str, Any], keys: tuple[str, ...], label: str) -> None:
    missing = [key for key in keys if key not in payload]
    if missing:
        raise SystemExit(f"{label} response missing keys: {', '.join(missing)}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--api-base",
        default=os.getenv("CADENCE_API_BASE", "http://localhost:5001"),
        help="Cadence API base URL. Defaults to CADENCE_API_BASE or localhost.",
    )
    parser.add_argument(
        "--admin-token",
        default=os.getenv("CADENCE_ADMIN_TOKEN"),
        help="Admin token. Defaults to CADENCE_ADMIN_TOKEN.",
    )
    parser.add_argument(
        "--origin",
        default=os.getenv("CADENCE_SMOKE_ORIGIN", "https://smoke.cadence.example"),
        help="Allowed origin to register and send with API-key requests.",
    )
    parser.add_argument(
        "--prefix",
        default=os.getenv("CADENCE_SMOKE_PREFIX", "cadence-smoke"),
        help="Prefix for generated app, slug, and user IDs.",
    )
    parser.add_argument(
        "--keep-key",
        action="store_true",
        help="Leave the generated API key active instead of revoking it at the end.",
    )
    args = parser.parse_args(argv)

    admin_token = require(args.admin_token, "Missing --admin-token or CADENCE_ADMIN_TOKEN.")
    run_id = str(int(time.time()))
    slug = f"{args.prefix}-{run_id}"
    raw_data = sample_payload()

    health = request_json(args.api_base, "GET", "/health")
    require(health.get("status") == "ok", f"Unexpected /health response: {health}")

    model_health = request_json(args.api_base, "GET", "/model/health")
    require("model_exists" in model_health, f"Unexpected /model/health response: {model_health}")

    registration_response = request_json(
        args.api_base,
        "POST",
        "/v1/app-registrations",
        {
            "name": f"Cadence Smoke {run_id}",
            "slug": slug,
            "contact_email": f"{slug}@example.com",
            "allowed_origins": [args.origin],
            "use_case": "Automated production smoke test",
        },
        expected=(201,),
    )
    registration = registration_response["registration"]
    registration_id = registration["app_registration_id"]
    lookup_token = registration_response["lookup_token"]
    require(registration.get("status") == "pending", f"Unexpected registration: {registration}")
    require(lookup_token.startswith("reg_status_"), "Registration response did not include lookup token")

    registration_status = request_json(
        args.api_base,
        "GET",
        f"/v1/app-registrations/{quote(registration_id, safe='')}/status",
        bearer_token=lookup_token,
    )
    require(
        registration_status["registration"].get("status") == "pending",
        f"Unexpected pre-approval registration status: {registration_status}",
    )

    request_json(
        args.api_base,
        "GET",
        "/v1/app-registrations",
        bearer_token=admin_token,
    )

    approval = request_json(
        args.api_base,
        "POST",
        f"/v1/app-registrations/{quote(registration_id, safe='')}/approve",
        {"key_name": "smoke"},
        bearer_token=admin_token,
        expected=(201,),
    )
    api_key = approval["api_key"]["key"]
    api_key_id = approval["api_key"]["api_key_id"]
    external_user_id = f"{slug}-user"

    registration_status = request_json(
        args.api_base,
        "GET",
        f"/v1/app-registrations/{quote(registration_id, safe='')}/status",
        bearer_token=lookup_token,
    )
    require(
        registration_status["registration"].get("status") == "approved",
        f"Unexpected post-approval registration status: {registration_status}",
    )
    require(
        registration_status["registration"].get("application_id") == approval["application"]["application_id"],
        f"Registration status did not expose approved application: {registration_status}",
    )

    enrollment_required = 1
    enroll_response: dict[str, Any] = {}
    for index in range(10):
        enroll_response = request_json(
            args.api_base,
            "POST",
            "/v1/enroll",
            {
                "external_user_id": external_user_id,
                "raw_data": raw_data,
                "source": "smoke",
                "successful": True,
                "quality_score": 1,
                "flags": ["smoke"],
            },
            bearer_token=api_key,
            origin=args.origin,
            expected=(201,),
        )
        enrollment_required = int(enroll_response.get("enrollment_required") or enrollment_required)
        if enroll_response.get("enrolled"):
            break
        if index + 1 >= enrollment_required:
            break

    require(enroll_response.get("enrolled"), f"User did not enroll: {enroll_response}")

    score_response = request_json(
        args.api_base,
        "POST",
        "/v1/score",
        {
            "external_user_id": external_user_id,
            "raw_data": raw_data,
            "store_successful_sample": False,
        },
        bearer_token=api_key,
        origin=args.origin,
    )
    assert_has_keys(
        score_response,
        ("score_request_id", "score", "confidence", "accepted", "match", "threshold", "reason"),
        "/v1/score",
    )
    require(score_response.get("enrolled") is True, f"Score response not enrolled: {score_response}")
    require(score_response.get("confidence") is not None, f"Score did not run model: {score_response}")
    require(isinstance(score_response.get("match"), bool), f"Score match is not boolean: {score_response}")

    usage_response = request_json(
        args.api_base,
        "GET",
        f"/v1/apps/{quote(approval['application']['application_id'], safe='')}/usage",
        bearer_token=admin_token,
    )
    usage = usage_response["usage"]
    require(usage["api_keys"]["total"] >= 1, f"Usage did not include generated key: {usage}")
    require(usage["end_users"]["total"] >= 1, f"Usage did not include generated end user: {usage}")
    require(usage["typing_samples"]["successful"] >= enrollment_required, f"Usage did not include enrollment samples: {usage}")
    require(usage["score_requests"]["total"] >= 1, f"Usage did not include score request: {usage}")

    if not args.keep_key:
        request_json(
            args.api_base,
            "POST",
            f"/v1/api-keys/{quote(api_key_id, safe='')}/revoke",
            bearer_token=admin_token,
        )

    print(json.dumps({
        "status": "ok",
        "registration_id": registration_id,
        "registration_status": registration_status["registration"]["status"],
        "application_id": approval["application"]["application_id"],
        "api_key_id": api_key_id,
        "external_user_id": external_user_id,
        "score_request_id": score_response["score_request_id"],
        "usage_score_requests": usage["score_requests"]["total"],
        "match": score_response["match"],
        "confidence": score_response["confidence"],
        "key_revoked": not args.keep_key,
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
