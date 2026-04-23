from flask import Flask, request, jsonify
from dotenv import load_dotenv
import os

load_dotenv()

from supabase import create_client

app = Flask(__name__)

print("URL:", os.getenv("SUPABASE_URL"))
print("KEY:", os.getenv("SUPABASE_KEY"))

supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_KEY")
)

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/authenticate")
def authenticate():
    data = request.json
    username = data.get("username")
    raw_data = data.get("raw_data")

    if not username:
        return jsonify({"status": "error", "message": "missing username"}), 400

    if raw_data is None:
        return jsonify({"status": "error", "message": "missing raw_data"}), 400

    user = supabase.table("user_profiles") \
        .select("*") \
        .eq("username", username) \
        .execute()

    if not user.data:
        return jsonify({"status": "user not found"}), 200

    return jsonify({
        "status": "2fa required"
    }), 200

@app.post("/code_verification")
def code_verification():
    data = request.json
    username = data.get("username")
    code = data.get("code")

    if not username:
        return jsonify({"status": "error", "message": "missing username"}), 400

    if not code:
        return jsonify({"status": "error", "message": "missing code"}), 400

    result = supabase.table("_2fa") \
    .select("*") \
    .eq("username", username) \
    .eq("otp_hash", code) \
    .execute()
    if not result.data:
        return jsonify({"status": "rejected"}), 200

    return jsonify({"status": "accepted"}), 200

if __name__ == "__main__":
    app.run(debug=True)