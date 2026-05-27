import unittest

from backend import app as cadence_app


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, db, table_name):
        self.db = db
        self.table_name = table_name
        self.filters = []
        self.insert_payload = None
        self.update_payload = None
        self.limit_value = None

    def select(self, *_args):
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def insert(self, payload):
        self.insert_payload = payload
        return self

    def update(self, payload):
        self.update_payload = payload
        return self

    def execute(self):
        rows = self.db.setdefault(self.table_name, [])

        if self.insert_payload is not None:
            payloads = (
                self.insert_payload
                if isinstance(self.insert_payload, list)
                else [self.insert_payload]
            )
            inserted = []
            for payload in payloads:
                row = dict(payload)
                self.db.add_ids(self.table_name, row)
                rows.append(row)
                inserted.append(row)
            return FakeResult(inserted)

        matched = list(rows)
        for column, value in self.filters:
            matched = [row for row in matched if row.get(column) == value]

        if self.update_payload is not None:
            for row in matched:
                row.update(self.update_payload)
            return FakeResult(matched)

        if self.limit_value is not None:
            matched = matched[: self.limit_value]
        return FakeResult(matched)


class FakeSupabase:
    ID_COLUMNS = {
        "api_keys": "api_key_id",
        "applications": "application_id",
        "end_users": "end_user_id",
        "typing_samples": "typing_sample_id",
        "score_requests": "score_request_id",
    }

    def __init__(self):
        self.tables = {
            "applications": [
                {"application_id": "app-1", "name": "Demo", "allowed_origins": []}
            ],
            "api_keys": [],
            "end_users": [],
            "typing_samples": [],
            "score_requests": [],
        }
        self.next_id = 1

    def table(self, table_name):
        return FakeQuery(self, table_name)

    def setdefault(self, table_name, default):
        return self.tables.setdefault(table_name, default)

    def add_ids(self, table_name, row):
        id_column = self.ID_COLUMNS.get(table_name)
        if id_column and id_column not in row:
            row[id_column] = f"{table_name}-{self.next_id}"
            self.next_id += 1


class FakeModelService:
    enrollment_limit = 10

    def raw_data_to_sample(self, raw_data):
        return raw_data["keystrokes"]

    def score_against_enrollment(self, current_sample, enrollment_samples):
        return 0.82


class PlatformApiTest(unittest.TestCase):
    def setUp(self):
        self.original_supabase = cadence_app.supabase
        self.original_model_service = cadence_app.model_service
        self.fake_supabase = FakeSupabase()
        api_key = "sk_live_test_key_for_platform_flow"
        self.api_key = api_key
        self.fake_supabase.tables["api_keys"].append({
            "api_key_id": "key-1",
            "application_id": "app-1",
            "key_prefix": api_key[: cadence_app.API_KEY_PREFIX_LENGTH],
            "key_hash": cadence_app.hash_api_key(api_key),
            "revoked_at": None,
        })
        cadence_app.supabase = self.fake_supabase
        cadence_app.model_service = FakeModelService()
        cadence_app.app.config["TESTING"] = True
        self.client = cadence_app.app.test_client()

    def tearDown(self):
        cadence_app.supabase = self.original_supabase
        cadence_app.model_service = self.original_model_service

    def auth_headers(self):
        return {"Authorization": f"Bearer {self.api_key}"}

    def test_platform_enroll_and_score_flow(self):
        raw_data = {
            "keystrokes": [
                {"hold_time": 80, "flight_time": 0, "down_down": 0},
                {"hold_time": 82, "flight_time": 42, "down_down": 122},
            ]
        }

        for _index in range(cadence_app.REQUIRED_ENROLLMENT_SAMPLES):
            response = self.client.post(
                "/v1/enroll",
                json={"external_user_id": "user-123", "raw_data": raw_data},
                headers=self.auth_headers(),
            )
            self.assertEqual(response.status_code, 201)

        response = self.client.post(
            "/v1/score",
            json={"external_user_id": "user-123", "raw_data": raw_data},
            headers=self.auth_headers(),
        )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["status"], "ok")
        self.assertTrue(body["enrolled"])
        self.assertTrue(body["accepted"])
        self.assertEqual(body["score"], 0.82)
        self.assertEqual(body["reason"], "accepted")
        self.assertEqual(len(self.fake_supabase.tables["score_requests"]), 1)


if __name__ == "__main__":
    unittest.main()
