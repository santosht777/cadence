# Cadence npm package

TypeScript utilities for integrating an application with Cadence typing
analysis.

## Install

```bash
npm install @cadence-auth/cadence
```

## Capture a browser sample

```ts
import { createCapture } from '@cadence-auth/cadence';

const input = document.querySelector<HTMLInputElement>('#password')!;
const capture = createCapture({
  target: input,
  mode: 'password',
  minLength: 8
});

capture.on('sample_ready', async ({ sample }) => {
  await fetch('/api/cadence/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sample })
  });
});

capture.start();
```

## Request app access

```ts
import { getAppRegistrationStatus, submitAppRegistration } from '@cadence-auth/cadence';

const request = await submitAppRegistration(
  { apiBaseUrl: 'https://api.example.com' },
  {
    name: 'Acme Dashboard',
    contact_email: 'dev@acme.example',
    allowed_origins: ['https://app.acme.example'],
    use_case: 'Score login typing samples for step-up authentication'
  }
);

const status = await getAppRegistrationStatus(
  {
    apiBaseUrl: 'https://api.example.com',
    lookupToken: request.lookup_token
  },
  request.registration.app_registration_id
);
```

## Call the Cadence API from trusted server code

Do not put an `sk_live_...` Cadence API key in browser code. Capture in
the browser, send the sample to your own backend, and call Cadence from
there.

```ts
import { createCadenceClient } from '@cadence-auth/cadence';

const cadence = createCadenceClient({
  apiBaseUrl: process.env.CADENCE_API_BASE!,
  apiKey: process.env.CADENCE_API_KEY!
});

export async function enrollUser(userId: string, sample: unknown) {
  return cadence.enroll({
    external_user_id: userId,
    raw_data: sample
  });
}

export async function scoreLogin(userId: string, sample: unknown) {
  const result = await cadence.score({
    external_user_id: userId,
    raw_data: sample
  });
  return {
    match: result.match,
    confidence: result.confidence,
    reason: result.reason
  };
}
```

The API accepts either a Cadence `Sample` with `events` or an object with
precomputed `keystrokes`.

The repository also includes `docs/release.md` with the publish checklist.
