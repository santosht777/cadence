'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createCapture } from '../vendor/index.js';

const VIEWS = ['landing', 'developer', 'register', 'login', 'twofa', 'dashboard'];
const VIEW_SET = new Set(VIEWS);

function readRouteFromLocation() {
  if (typeof window === 'undefined') return 'landing';
  const hashMatch = window.location.hash.match(/^#\/(\w+)/);
  if (hashMatch) return VIEW_SET.has(hashMatch[1]) ? hashMatch[1] : 'landing';
  const pathRoute = window.location.pathname.replace(/^\/+/, '').split('/')[0];
  return VIEW_SET.has(pathRoute) ? pathRoute : 'landing';
}

function getApiBase() {
  if (typeof window === 'undefined') return 'http://localhost:5001';
  return (
    window.SYNERGYZE_API_BASE ||
    process.env.NEXT_PUBLIC_SYNERGYZE_API_BASE ||
    window.localStorage.getItem('synergyze.api_base') ||
    'http://localhost:5001'
  );
}

// Detect mobile/touch devices so the backend can skip biometric scoring
// (trained on desktop typing) and fall straight through to 2FA instead.
// Combines two independent signals — touch capability and coarse pointer
// (touchscreen) — which together are reliable without reading user-agent strings.
function isMobileDevice() {
  if (typeof window === 'undefined') return false;
  return navigator.maxTouchPoints > 0 &&
         window.matchMedia('(pointer: coarse)').matches;
}

// Hash the password client-side before it ever leaves the browser.

function Status({ value }) {
  const kind = value?.kind ? ` is-${value.kind}` : '';
  return <p className={`auth-meta${kind}`} data-form-status>{value?.message ?? ''}</p>;
}

function Enrollment({ payload }) {
  if (
    !payload ||
    typeof payload.enrollment_required !== 'number' ||
    typeof payload.enrollment_count !== 'number' ||
    payload.enrolled
  ) {
    return null;
  }

  const required = payload.enrollment_required;
  const count = Math.min(payload.enrollment_count, required);
  const pct = required > 0 ? (count / required) * 100 : 100;
  const text = payload.enrolled
    ? `Fully enrolled (${count}/${required}). Biometric login active.`
    : `${count}/${required} clean samples collected - ${
        payload.enrollment_samples_needed ?? required - count
      } more to enable biometric login.`;

  return (
    <div className="enrollment" id="enrollment-status">
      <p className="aside-eyebrow">Enrollment progress</p>
      <div className="enrollment-bar">
        <div className="enrollment-fill" id="enrollment-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="enrollment-text" id="enrollment-text">{text}</p>
    </div>
  );
}

export default function SynergyzeApp({ initialRoute = 'landing' }) {
  const [view, setView] = useState(VIEW_SET.has(initialRoute) ? initialRoute : 'landing');
  const [statuses, setStatuses] = useState({
    developer: { message: '', kind: '' },
    register: { message: '', kind: '' },
    login: { message: '', kind: '' },
    twofa: { message: '', kind: '' }
  });
  const [developerConfig, setDeveloperConfig] = useState({
    apiBase: '',
    adminToken: ''
  });
  const [developerApps, setDeveloperApps] = useState([]);
  const [developerRegistrations, setDeveloperRegistrations] = useState([]);
  const [selectedDeveloperAppId, setSelectedDeveloperAppId] = useState('');
  const [developerKeys, setDeveloperKeys] = useState([]);
  const [newDeveloperKey, setNewDeveloperKey] = useState(null);
  const [newDeveloperLookup, setNewDeveloperLookup] = useState(null);
  const [developerRequestStatus, setDeveloperRequestStatus] = useState(null);
  const [developerUsage, setDeveloperUsage] = useState(null);
  const [developerLoading, setDeveloperLoading] = useState(false);
  const [demoOtp, setDemoOtp] = useState(null);
  const [dashboardSub, setDashboardSub] = useState(
    'Welcome back. The paradigm has been shifted on your behalf.'
  );
  const [enrollment, setEnrollment] = useState(null);
  const [activeUsername, setActiveUsername] = useState(null);

  const registerEmailRef = useRef(null);
  const registerUsernameRef = useRef(null);
  const registerPasswordRef = useRef(null);
  const loginUsernameRef = useRef(null);
  const loginPasswordRef = useRef(null);
  const twofaCodeRef = useRef(null);
  const developerAppNameRef = useRef(null);
  const developerSlugRef = useRef(null);
  const developerOriginsRef = useRef(null);
  const developerKeyNameRef = useRef(null);
  const developerRequestNameRef = useRef(null);
  const developerRequestEmailRef = useRef(null);
  const developerRequestSlugRef = useRef(null);
  const developerRequestOriginsRef = useRef(null);
  const developerRequestUseCaseRef = useRef(null);
  const developerStatusIdRef = useRef(null);
  const developerStatusTokenRef = useRef(null);
  const activeCaptureRef = useRef(null);
  const pendingAuthRef = useRef({ username: null, loginAttemptId: null });


  const setStatus = useCallback((form, message, kind = '') => {
    setStatuses((current) => ({
      ...current,
      [form]: { message, kind }
    }));
  }, []);

  const teardownCapture = useCallback(() => {
    const active = activeCaptureRef.current;
    if (!active) return;
    try {
      active.session.destroy();
    } catch {}
    activeCaptureRef.current = null;
  }, []);

  const attachCapture = useCallback((input) => {
    teardownCapture();
    if (!input) return;

    let lastSample = null;
    let lastRejection = null;
    const session = createCapture({
      target: input,
      mode: 'password',
      minLength: 1,
      onSample: (sample) => {
        lastSample = sample;
      }
    });

    session.on('error', (ev) => console.warn('[cadence]', ev.error));
    session.on('sample_rejected', (ev) => {
      lastRejection = ev.reason;
    });
    session.start();
    activeCaptureRef.current = {
      session,
      finalize() {
        lastSample = null;
        lastRejection = null;
        session.stop();
        return { sample: lastSample, rejection: lastRejection };
      }
    };
  }, [teardownCapture]);

  const showView = useCallback((name, { replace = false } = {}) => {
    const target = VIEW_SET.has(name) ? name : 'landing';
    setView(target);
    if (typeof window === 'undefined') return;

    if (target !== 'landing') {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }

    const path = target === 'landing' ? '/' : `/${target}`;
    if (window.location.pathname !== path || window.location.hash.startsWith('#/')) {
      const method = replace ? 'replaceState' : 'pushState';
      window.history[method](null, '', path);
    }
  }, []);

  const routeTo = useCallback((target) => (ev) => {
    ev.preventDefault();
    showView(target);
  }, [showView]);

  const api = useCallback(async (path, body) => {
    const res = await fetch(`${getApiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    let json;
    try {
      json = await res.json();
    } catch {
      json = { status: 'error', message: `bad response (${res.status})` };
    }
    return { ok: res.ok, status: res.status, json };
  }, []);

  const developerApi = useCallback(async (path, { method = 'GET', body } = {}) => {
    const apiBase = developerConfig.apiBase || getApiBase();
    const token = developerConfig.adminToken.trim();
    if (!token) {
      throw new Error('Enter an admin token first.');
    }

    const res = await fetch(`${apiBase.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    let json;
    try {
      json = await res.json();
    } catch {
      json = { status: 'error', message: `bad response (${res.status})` };
    }
    if (!res.ok) {
      throw new Error(json.message || `Request failed (${res.status})`);
    }
    return json;
  }, [developerConfig]);

  const publicPlatformApi = useCallback(async (path, body) => {
    const apiBase = (developerConfig.apiBase || getApiBase()).replace(/\/+$/, '');
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    let json;
    try {
      json = await res.json();
    } catch {
      json = { status: 'error', message: `bad response (${res.status})` };
    }
    if (!res.ok) {
      throw new Error(json.message || `Request failed (${res.status})`);
    }
    return json;
  }, [developerConfig.apiBase]);

  const refreshDeveloperApps = useCallback(async (preferredAppId = selectedDeveloperAppId) => {
    setDeveloperLoading(true);
    setStatus('developer', 'Loading applications...');
    try {
      const json = await developerApi('/v1/apps');
      const apps = json.applications || [];
      setDeveloperApps(apps);
      const nextSelected =
        apps.find((app) => app.application_id === preferredAppId)?.application_id ||
        apps[0]?.application_id ||
        '';
      setSelectedDeveloperAppId(nextSelected);
      setStatus('developer', apps.length ? 'Applications loaded.' : 'No applications registered yet.', 'success');
    } catch (err) {
      setStatus('developer', err.message, 'error');
    } finally {
      setDeveloperLoading(false);
    }
  }, [developerApi, selectedDeveloperAppId, setStatus]);

  const refreshDeveloperRegistrations = useCallback(async () => {
    setDeveloperLoading(true);
    setStatus('developer', 'Loading registration requests...');
    try {
      const json = await developerApi('/v1/app-registrations');
      setDeveloperRegistrations(json.registrations || []);
      setStatus('developer', 'Registration requests loaded.', 'success');
    } catch (err) {
      setStatus('developer', err.message, 'error');
    } finally {
      setDeveloperLoading(false);
    }
  }, [developerApi, setStatus]);

  const refreshDeveloperKeys = useCallback(async (applicationId = selectedDeveloperAppId) => {
    if (!applicationId) {
      setDeveloperKeys([]);
      return;
    }
    setDeveloperLoading(true);
    setStatus('developer', 'Loading API keys...');
    try {
      const json = await developerApi(`/v1/apps/${encodeURIComponent(applicationId)}/api-keys`);
      setDeveloperKeys(json.api_keys || []);
      setStatus('developer', 'API keys loaded.', 'success');
    } catch (err) {
      setStatus('developer', err.message, 'error');
    } finally {
      setDeveloperLoading(false);
    }
  }, [developerApi, selectedDeveloperAppId, setStatus]);

  const refreshDeveloperUsage = useCallback(async (applicationId = selectedDeveloperAppId) => {
    if (!applicationId) {
      setDeveloperUsage(null);
      return;
    }
    setDeveloperLoading(true);
    setStatus('developer', 'Loading usage...');
    try {
      const json = await developerApi(`/v1/apps/${encodeURIComponent(applicationId)}/usage`);
      setDeveloperUsage(json.usage || null);
      setStatus('developer', 'Usage loaded.', 'success');
    } catch (err) {
      setDeveloperUsage(null);
      setStatus('developer', err.message, 'error');
    } finally {
      setDeveloperLoading(false);
    }
  }, [developerApi, selectedDeveloperAppId, setStatus]);

  const goToDashboard = useCallback((message, payload, username = null) => {
    if (message) setDashboardSub(message);
    setEnrollment(payload);
    setActiveUsername(username);
    showView('dashboard');
  }, [showView]);


  useEffect(() => {
    if (typeof window === 'undefined') return;
    setDeveloperConfig({
      apiBase: window.localStorage.getItem('cadence.developer_api_base') || getApiBase(),
      adminToken: window.localStorage.getItem('cadence.admin_token') || ''
    });
  }, []);

  useEffect(() => {
    const syncRoute = () => showView(readRouteFromLocation(), { replace: true });
    syncRoute();
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
    return () => {
      window.removeEventListener('popstate', syncRoute);
      window.removeEventListener('hashchange', syncRoute);
    };
  }, [showView]);

  useEffect(() => {
    if (view === 'login') {
      attachCapture(loginPasswordRef.current);
    } else {
      teardownCapture();
    }
    if (view === 'twofa') {
      if (twofaCodeRef.current) twofaCodeRef.current.value = '';
    } else {
      setDemoOtp(null);
    }
  }, [attachCapture, teardownCapture, view]);

  useEffect(() => teardownCapture, [teardownCapture]);

  useEffect(() => {
    if (selectedDeveloperAppId) {
      refreshDeveloperKeys(selectedDeveloperAppId);
      refreshDeveloperUsage(selectedDeveloperAppId);
    } else {
      setDeveloperKeys([]);
      setDeveloperUsage(null);
    }
  }, [refreshDeveloperKeys, refreshDeveloperUsage, selectedDeveloperAppId]);

  const updateDeveloperConfig = (field) => (ev) => {
    const value = ev.target.value;
    setDeveloperConfig((current) => {
      const next = { ...current, [field]: value };
      if (typeof window !== 'undefined') {
        if (field === 'apiBase') {
          window.localStorage.setItem('cadence.developer_api_base', value);
        }
        if (field === 'adminToken') {
          window.localStorage.setItem('cadence.admin_token', value);
        }
      }
      return next;
    });
  };

  const handleCreateDeveloperApp = async (ev) => {
    ev.preventDefault();
    const name = developerAppNameRef.current.value.trim();
    const slug = developerSlugRef.current.value.trim();
    const origins = developerOriginsRef.current.value
      .split(/\n|,/)
      .map((origin) => origin.trim())
      .filter(Boolean);

    if (!name) {
      setStatus('developer', 'Application name is required.', 'error');
      return;
    }

    setDeveloperLoading(true);
    setNewDeveloperKey(null);
    setStatus('developer', 'Registering application...');
    try {
      const body = { name, allowed_origins: origins };
      if (slug) body.slug = slug;
      const json = await developerApi('/v1/apps', { method: 'POST', body });
      developerAppNameRef.current.value = '';
      developerSlugRef.current.value = '';
      developerOriginsRef.current.value = '';
      setSelectedDeveloperAppId(json.application.application_id);
      await refreshDeveloperApps(json.application.application_id);
      setStatus('developer', 'Application registered.', 'success');
    } catch (err) {
      setStatus('developer', err.message, 'error');
    } finally {
      setDeveloperLoading(false);
    }
  };

  const handleSubmitDeveloperRequest = async (ev) => {
    ev.preventDefault();
    const name = developerRequestNameRef.current.value.trim();
    const contactEmail = developerRequestEmailRef.current.value.trim();
    const slug = developerRequestSlugRef.current.value.trim();
    const origins = developerRequestOriginsRef.current.value
      .split(/\n|,/)
      .map((origin) => origin.trim())
      .filter(Boolean);
    const useCase = developerRequestUseCaseRef.current.value.trim();

    if (!name || !contactEmail) {
      setStatus('developer', 'Application name and contact email are required.', 'error');
      return;
    }

    setDeveloperLoading(true);
    setStatus('developer', 'Submitting registration request...');
    try {
      const body = {
        name,
        contact_email: contactEmail,
        allowed_origins: origins,
        use_case: useCase
      };
      if (slug) body.slug = slug;
      const json = await publicPlatformApi('/v1/app-registrations', body);
      setNewDeveloperLookup({
        appRegistrationId: json.registration.app_registration_id,
        lookupToken: json.lookup_token
      });
      setDeveloperRequestStatus(json.registration);
      developerRequestNameRef.current.value = '';
      developerRequestEmailRef.current.value = '';
      developerRequestSlugRef.current.value = '';
      developerRequestOriginsRef.current.value = '';
      developerRequestUseCaseRef.current.value = '';
      setStatus(
        'developer',
        `Registration request submitted (${json.registration.app_registration_id}).`,
        'success'
      );
    } catch (err) {
      setStatus('developer', err.message, 'error');
    } finally {
      setDeveloperLoading(false);
    }
  };

  const handleLookupDeveloperRequest = async (ev) => {
    ev.preventDefault();
    const registrationId = developerStatusIdRef.current.value.trim();
    const lookupToken = developerStatusTokenRef.current.value.trim();
    if (!registrationId || !lookupToken) {
      setStatus('developer', 'Registration ID and lookup token are required.', 'error');
      return;
    }

    setDeveloperLoading(true);
    setStatus('developer', 'Checking registration status...');
    try {
      const apiBase = (developerConfig.apiBase || getApiBase()).replace(/\/+$/, '');
      const res = await fetch(
        `${apiBase}/v1/app-registrations/${encodeURIComponent(registrationId)}/status`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${lookupToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      let json;
      try {
        json = await res.json();
      } catch {
        json = { status: 'error', message: `bad response (${res.status})` };
      }
      if (!res.ok) {
        throw new Error(json.message || `Request failed (${res.status})`);
      }
      setDeveloperRequestStatus(json.registration);
      setStatus('developer', `Registration is ${json.registration.status}.`, 'success');
    } catch (err) {
      setStatus('developer', err.message, 'error');
    } finally {
      setDeveloperLoading(false);
    }
  };

  const handleCreateDeveloperKey = async (ev) => {
    ev.preventDefault();
    if (!selectedDeveloperAppId) {
      setStatus('developer', 'Select an application first.', 'error');
      return;
    }
    const name = developerKeyNameRef.current.value.trim() || 'default';
    setDeveloperLoading(true);
    setNewDeveloperKey(null);
    setStatus('developer', 'Creating API key...');
    try {
      const json = await developerApi(
        `/v1/apps/${encodeURIComponent(selectedDeveloperAppId)}/api-keys`,
        { method: 'POST', body: { name } }
      );
      setNewDeveloperKey(json.api_key);
      developerKeyNameRef.current.value = '';
      await refreshDeveloperKeys(selectedDeveloperAppId);
      await refreshDeveloperUsage(selectedDeveloperAppId);
      setStatus('developer', 'API key created. Copy it now; Cadence will not show it again.', 'success');
    } catch (err) {
      setStatus('developer', err.message, 'error');
    } finally {
      setDeveloperLoading(false);
    }
  };

  const handleRevokeDeveloperKey = async (apiKeyId) => {
    setDeveloperLoading(true);
    setStatus('developer', 'Revoking API key...');
    try {
      await developerApi(`/v1/api-keys/${encodeURIComponent(apiKeyId)}/revoke`, {
        method: 'POST'
      });
      await refreshDeveloperKeys(selectedDeveloperAppId);
      await refreshDeveloperUsage(selectedDeveloperAppId);
      setStatus('developer', 'API key revoked.', 'success');
    } catch (err) {
      setStatus('developer', err.message, 'error');
    } finally {
      setDeveloperLoading(false);
    }
  };

  const handleApproveDeveloperRegistration = async (registrationId) => {
    setDeveloperLoading(true);
    setNewDeveloperKey(null);
    setStatus('developer', 'Approving registration...');
    try {
      const json = await developerApi(`/v1/app-registrations/${encodeURIComponent(registrationId)}/approve`, {
        method: 'POST',
        body: { key_name: 'production' }
      });
      setNewDeveloperKey(json.api_key);
      await refreshDeveloperRegistrations();
      await refreshDeveloperApps(json.application.application_id);
      setStatus('developer', 'Registration approved. Copy the new API key now.', 'success');
    } catch (err) {
      setStatus('developer', err.message, 'error');
    } finally {
      setDeveloperLoading(false);
    }
  };

  const handleRejectDeveloperRegistration = async (registrationId) => {
    setDeveloperLoading(true);
    setStatus('developer', 'Rejecting registration...');
    try {
      await developerApi(`/v1/app-registrations/${encodeURIComponent(registrationId)}/reject`, {
        method: 'POST'
      });
      await refreshDeveloperRegistrations();
      setStatus('developer', 'Registration rejected.', 'success');
    } catch (err) {
      setStatus('developer', err.message, 'error');
    } finally {
      setDeveloperLoading(false);
    }
  };

  const handleRegister = async (ev) => {
    ev.preventDefault();
    const email = registerEmailRef.current.value.trim();
    const username = registerUsernameRef.current.value.trim();
    const password = registerPasswordRef.current.value;

    if (!email || !username || !password) {
      setStatus('register', 'Please fill in every field.', 'error');
      return;
    }
    setStatus('register', 'Disrupting the auth provider...');
    try {
      const { ok, json } = await api('/signup', { email, username, password });
      if (json.status === 'signup_success') {
        setStatus('register', 'Account created. Redirecting to sign in...', 'success');
        window.setTimeout(() => {
          if (loginUsernameRef.current) loginUsernameRef.current.value = username;
          showView('login');
        }, 700);
        return;
      }
      setStatus(
        'register',
        json.message || `Signup failed (${ok ? 'unknown' : 'server'} error).`,
        'error'
      );
    } catch (err) {
      setStatus('register', `Network error: ${err.message}`, 'error');
    }
  };

  const handleLogin = async (ev) => {
    ev.preventDefault();
    const username = loginUsernameRef.current.value.trim();
    const password = loginPasswordRef.current.value;

    if (!username || !password) {
      setStatus('login', 'Please fill in every field.', 'error');
      return;
    }

    const capture = activeCaptureRef.current
      ? activeCaptureRef.current.finalize()
      : { sample: null, rejection: 'session_not_started' };
    const sample = capture.sample;
    if (!sample || sample.events.length === 0) {
      const message =
        capture.rejection === 'poisoned'
          ? 'Clear the password field and type it manually before signing in.'
          : 'Type your password manually before signing in.';
      if (loginPasswordRef.current) loginPasswordRef.current.value = '';
      setStatus('login', message, 'error');
      attachCapture(loginPasswordRef.current);
      return;
    }
    const events = sample ? sample.events : [];
    // Encrypt the keystroke events with the server's RSA public key before
    const raw_data = { events };
    const is_mobile = isMobileDevice();

    setStatus('login', 'Analyzing your typing rhythm...');
    try {
      const { json } = await api('/authenticate', { username, password, raw_data, is_mobile });

      switch (json.status) {
        case 'accepted':
          goToDashboard('Welcome back. The paradigm is yours.', json, username);
          return;
        case '2fa required': {
          pendingAuthRef.current = {
            username,
            loginAttemptId: json.login_attempt_id
          };
          setDemoOtp(json.demo_otp || null);
          const reasonNote =
            json.reason === 'enrollment_required'
              ? `Enrollment in progress (${json.enrollment_count}/${json.enrollment_required}). Check your email for a code.`
              : json.reason === 'mobile_device'
              ? 'Mobile sign-in detected — check your email for a verification code.'
              : 'Your typing rhythm looked off. Check your email for a code.';
          setStatus('login', reasonNote, 'success');
          window.setTimeout(() => showView('twofa'), 600);
          return;
        }
        case 'pending 2fa':
          setStatus('login', 'A previous login is still pending verification.', 'error');
          return;
        case 'logged in':
          goToDashboard('Already signed in elsewhere. Carry on.', null, username);
          return;
        case 'account is locked':
          setStatus(
            'login',
            'Account locked after too many failed codes. Contact support (us, on Twitter).',
            'error'
          );
          return;
        case 'password_locked':
          // Too many wrong passwords — an unlock code was emailed to the owner.
          if (json.login_attempt_id) {
            pendingAuthRef.current = { username, loginAttemptId: json.login_attempt_id };
            setDemoOtp(json.demo_otp || null);
            setStatus('login', 'Too many failed attempts — check your email for an unlock code.', 'error');
            window.setTimeout(() => showView('twofa'), 800);
          } else {
            setStatus('login', 'Account locked due to too many failed attempts. Check your email for an unlock code.', 'error');
          }
          return;
        case 'user not found':
          setStatus('login', 'Invalid username or password.', 'error');
          return;
        default:
          setStatus('login', json.message || 'Login failed. Try again.', 'error');
          attachCapture(loginPasswordRef.current);
      }
    } catch (err) {
      setStatus('login', `Network error: ${err.message}`, 'error');
      attachCapture(loginPasswordRef.current);
    }
  };

  const handleTwofa = async (ev) => {
    ev.preventDefault();
    const code = twofaCodeRef.current.value.trim();
    const pendingAuth = pendingAuthRef.current;

    if (!pendingAuth.username || !pendingAuth.loginAttemptId) {
      setStatus('twofa', 'No pending login. Start over.', 'error');
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setStatus('twofa', 'Enter the 6-digit code.', 'error');
      return;
    }

    setStatus('twofa', 'Verifying...');
    try {
      const { json } = await api('/code_verification', {
        username: pendingAuth.username,
        login_attempt_id: pendingAuth.loginAttemptId,
        code
      });

      if (json.status === 'unlocked') {
        // This was a password-unlock verification, not a real login.
        // Clear pending state and send the user back to sign in normally.
        pendingAuthRef.current = { username: null, loginAttemptId: null };
        setStatus('twofa', 'Account unlocked. Please sign in again.', 'success');
        window.setTimeout(() => showView('login'), 1200);
        return;
      }
      if (json.status === 'accepted') {
        const verifiedUsername = pendingAuth.username;
        pendingAuthRef.current = { username: null, loginAttemptId: null };
        const message = json.enrolled
          ? 'Verified. You are now fully enrolled.'
          : 'Verified. Keep going - every clean login enrolls another sample.';
        goToDashboard(message, json, verifiedUsername);
        return;
      }
      if (json.message === 'max attempts exceeded') {
        setStatus('twofa', 'Max attempts exceeded. Account locked.', 'error');
        return;
      }
      if (json.message === 'expired') {
        setStatus('twofa', 'Code expired. Resend a new one.', 'error');
        return;
      }
      if (json.message === 'invalid attempt') {
        setStatus('twofa', 'This login attempt is no longer valid.', 'error');
        return;
      }
      setStatus('twofa', 'Wrong code. Try again.', 'error');
    } catch (err) {
      setStatus('twofa', `Network error: ${err.message}`, 'error');
    }
  };

  const handleResend = async (ev) => {
    ev.preventDefault();
    const pendingAuth = pendingAuthRef.current;
    if (!pendingAuth.username || !pendingAuth.loginAttemptId) {
      setStatus('twofa', 'No pending login.', 'error');
      return;
    }

    setStatus('twofa', 'Sending a new code...');
    try {
      const { json } = await api('/resend_code', {
        username: pendingAuth.username,
        login_attempt_id: pendingAuth.loginAttemptId
      });
      if (json.status === 'code sent') {
        setDemoOtp(json.demo_otp || null);
        setStatus('twofa', 'New code sent.', 'success');
      } else {
        setStatus('twofa', json.message || 'Could not resend.', 'error');
      }
    } catch (err) {
      setStatus('twofa', `Network error: ${err.message}`, 'error');
    }
  };

  const handleLogout = async () => {
    const username = activeUsername;
    pendingAuthRef.current = { username: null, loginAttemptId: null };
    setActiveUsername(null);
    setEnrollment(null);

    if (username) {
      try {
        await api('/logout', { username });
      } catch (err) {
        console.warn('[cadence] logout failed', err);
      }
    }

    showView('landing');
  };

  return (
    <>
      <div className="bg-gradient" aria-hidden="true"></div>
      <div className="bg-grid" aria-hidden="true"></div>

      <header className="nav">
        <a className="brand" href="/" onClick={routeTo('landing')}>
          <span className="brand-mark">◈</span>
          <span className="brand-name">Synergyze</span>
          <span className="brand-tld">.ai</span>
        </a>
        <nav className="nav-links">
          <a href="/#features">Features</a>
          <a href="/developer" onClick={routeTo('developer')}>Developers</a>
          <a href="/#social">Trusted By</a>
          <a href="/#pricing">Pricing</a>
          <a href="/#manifesto">Manifesto</a>
        </nav>
        <div className="nav-cta">
          <a className="btn btn-ghost" href="/developer" onClick={routeTo('developer')}>
            Developer console
          </a>
          <a className="btn btn-ghost" href="/login" onClick={routeTo('login')}>Sign in</a>
          <a className="btn btn-primary" href="/register" onClick={routeTo('register')}>
            Start free trial
          </a>
        </div>
      </header>

      <main id="app">
        <section className="route route-landing" data-route-view="landing" hidden={view !== 'landing'}>
          <div className="hero">
            <div className="badge">
              <span className="badge-dot"></span>
              Series Pre-Seed · backed by your uncle
            </div>

            <h1 className="hero-title">
              Unlock <em>10×</em> synergy with the world's first{' '}
              <span className="gradient-text">AI-native quantum thought-leadership platform.</span>
            </h1>

            <p className="hero-sub">
              Synergyze leverages a proprietary blockchain-agnostic LLM mesh to transform your team's
              vibes into actionable paradigms. No code. No users. No problem.
            </p>

            <div className="hero-cta">
              <a className="btn btn-primary btn-lg" href="/register" onClick={routeTo('register')}>
                Get started free <span className="arrow">→</span>
              </a>
              <a className="btn btn-ghost btn-lg" href="/login" onClick={routeTo('login')}>
                Sign in
              </a>
            </div>

            <ul className="hero-stats">
              <li>
                <strong>0</strong>
                <span>Fortune 500 customers</span>
              </li>
              <li>
                <strong>∞</strong>
                <span>Synergistic outcomes / mo</span>
              </li>
              <li>
                <strong>1.21<small>GW</small></strong>
                <span>Of pure ideation</span>
              </li>
              <li>
                <strong>9.8s</strong>
                <span>Avg time to disruption</span>
              </li>
            </ul>
          </div>

          <section className="logos" id="social" aria-label="As seen in">
            <p className="logos-label">As featured nowhere, allegedly</p>
            <div className="logos-row">
              <span>TechCrunch†</span>
              <span>Forbes 30 Under 90</span>
              <span>Y Comb&shy;inator (Rejected)</span>
              <span>Hacker News (Flagged)</span>
              <span>Product Hunt #847</span>
            </div>
          </section>

          <section className="features" id="features">
            <header className="section-head">
              <p className="eyebrow">The platform</p>
              <h2>One stack. Zero use cases. Infinite synergy.</h2>
            </header>

            <div className="feature-grid">
              <article className="feature-card">
                <div className="feature-icon">⚛︎</div>
                <h3>Quantum Synergy Engine™</h3>
                <p>
                  Our patent-pending engine collapses your team's wave function into a single
                  low-resolution Slack message. Schrödinger's standup, finally solved.
                </p>
              </article>

              <article className="feature-card">
                <div className="feature-icon">⌬</div>
                <h3>AI-First Disruption Layer</h3>
                <p>
                  Disrupt your industry by disrupting your own roadmap. Our LLM-powered pivot
                  generator ships a new strategy every 14 minutes, whether you asked or not.
                </p>
              </article>

              <article className="feature-card">
                <div className="feature-icon">⛓︎</div>
                <h3>Blockchain-Agnostic Workflows</h3>
                <p>
                  We don't use blockchain. We don't <em>not</em> use blockchain. Investors love
                  this slide, and so will you.
                </p>
              </article>

              <article className="feature-card">
                <div className="feature-icon">◉</div>
                <h3>Vibe-Driven Development</h3>
                <p>
                  Replace your specs, tickets, and engineers with a single Notion page that just
                  says "make it pop." Powered by GPT and good feelings.
                </p>
              </article>

              <article className="feature-card">
                <div className="feature-icon">⌁</div>
                <h3>Realtime Paradigm Shifter</h3>
                <p>
                  Detects when your competitors raise a Series B and automatically rewrites your
                  homepage to claim you did it first.
                </p>
              </article>

              <article className="feature-card">
                <div className="feature-icon">∞</div>
                <h3>Infinite Scale, Finite Bugs</h3>
                <p>
                  Engineered to scale to 10 billion users, currently serving three. Two of them are
                  co-founders. One is a bot.
                </p>
              </article>
            </div>
          </section>

          <section className="quote">
            <blockquote>
              "Synergyze didn't just transform our company. It transformed our company{' '}
              <em>twice</em>, then refunded our money, then charged us again. Honestly, the
              velocity is unmatched."
            </blockquote>
            <footer>
              <strong>Chad McThoughtleader</strong>
              <span>VP of Innovation, TBD&nbsp;Corp&nbsp;(stealth)</span>
            </footer>
          </section>

          <section className="cta-band" id="pricing">
            <h2 id="manifesto">A manifesto, of sorts.</h2>
            <p>
              We believe in synergy. We believe in disruption. We believe the words "synergy" and
              "disruption" can be combined to form "syndruption," and that the word "syndruption"
              is, itself, a kind of synergy. We are not currently accepting customers.
            </p>
            <p className="cta-meta">
              - The Synergyze Founding Team (one person, two LinkedIn profiles)
            </p>
          </section>

          <footer className="site-footer">
            <p className="powered-by">
              <span className="powered-mark">◈</span>
              Auth genuinely powered by{' '}
              <a href="https://github.com/" target="_blank" rel="noopener noreferrer">
                <strong>Cadence</strong>
              </a>{' '}
              - the only working piece of technology in this entire product.
            </p>
            <small>
              © 2026 Synergyze, Inc. † not actually featured. Patent pending&nbsp;(rejected). All
              rights reserved (some).
            </small>
          </footer>
        </section>

        <section className="route route-developer" data-route-view="developer" hidden={view !== 'developer'}>
          <div className="developer-shell">
            <header className="developer-header">
              <a className="auth-back developer-back" href="/" onClick={routeTo('landing')}>← back to home</a>
              <p className="eyebrow">Cadence platform</p>
              <h1>Register apps and manage typing-analysis keys</h1>
              <p>
                Create an application, restrict browser origins, issue a server-side API key, and
                connect the npm package to the model scoring API.
              </p>
            </header>

            <div className="developer-grid">
              <section className="developer-panel developer-panel-wide">
                <h2>Request developer access</h2>
                <form className="developer-request-grid" onSubmit={handleSubmitDeveloperRequest}>
                  <label className="field">
                    <span className="field-label">Application name</span>
                    <input
                      ref={developerRequestNameRef}
                      type="text"
                      placeholder="Acme dashboard"
                      autoComplete="organization"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Contact email</span>
                    <input
                      ref={developerRequestEmailRef}
                      type="email"
                      placeholder="dev@company.com"
                      autoComplete="email"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Preferred slug</span>
                    <input
                      ref={developerRequestSlugRef}
                      type="text"
                      placeholder="acme-dashboard"
                      autoComplete="off"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Allowed origins</span>
                    <textarea
                      ref={developerRequestOriginsRef}
                      placeholder="https://app.example.com&#10;https://staging.example.com"
                      rows={4}
                    />
                  </label>
                  <label className="field developer-field-wide">
                    <span className="field-label">Use case</span>
                    <textarea
                      ref={developerRequestUseCaseRef}
                      placeholder="Where will Cadence score typing samples in your app?"
                      rows={4}
                    />
                  </label>
                  <button type="submit" className="btn btn-primary" disabled={developerLoading}>
                    Submit request <span className="arrow">→</span>
                  </button>
                </form>

                {newDeveloperLookup && (
                  <div className="developer-secret developer-secret-spaced">
                    <span>Registration lookup token</span>
                    <code>{newDeveloperLookup.lookupToken}</code>
                    <small>Request ID: {newDeveloperLookup.appRegistrationId}</small>
                  </div>
                )}

                <form className="developer-status-form" onSubmit={handleLookupDeveloperRequest}>
                  <label className="field">
                    <span className="field-label">Registration ID</span>
                    <input
                      ref={developerStatusIdRef}
                      type="text"
                      placeholder="app registration uuid"
                      autoComplete="off"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Lookup token</span>
                    <input
                      ref={developerStatusTokenRef}
                      type="password"
                      placeholder="reg_status_..."
                      autoComplete="off"
                    />
                  </label>
                  <button type="submit" className="btn btn-ghost" disabled={developerLoading}>
                    Check status
                  </button>
                </form>

                {developerRequestStatus && (
                  <div className="developer-status-card">
                    <span className={`developer-registration-status is-${developerRequestStatus.status}`}>
                      {developerRequestStatus.status}
                    </span>
                    <strong>{developerRequestStatus.name}</strong>
                    <small>{developerRequestStatus.application_id || developerRequestStatus.app_registration_id}</small>
                  </div>
                )}
              </section>

              <section className="developer-panel">
                <h2>Connection</h2>
                <div className="developer-form">
                  <label className="field">
                    <span className="field-label">API base URL</span>
                    <input
                      type="url"
                      value={developerConfig.apiBase}
                      onChange={updateDeveloperConfig('apiBase')}
                      placeholder="https://api.example.com"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Admin token</span>
                    <input
                      type="password"
                      value={developerConfig.adminToken}
                      onChange={updateDeveloperConfig('adminToken')}
                      placeholder="cadence admin token"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-ghost btn-block"
                    onClick={() => refreshDeveloperApps()}
                    disabled={developerLoading}
                  >
                    Load applications
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-block"
                    onClick={refreshDeveloperRegistrations}
                    disabled={developerLoading}
                  >
                    Load registration requests
                  </button>
                </div>
                <Status value={statuses.developer} />
              </section>

              <section className="developer-panel">
                <h2>Register application</h2>
                <form className="developer-form" onSubmit={handleCreateDeveloperApp}>
                  <label className="field">
                    <span className="field-label">Application name</span>
                    <input
                      ref={developerAppNameRef}
                      type="text"
                      placeholder="Acme dashboard"
                      autoComplete="off"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Slug</span>
                    <input
                      ref={developerSlugRef}
                      type="text"
                      placeholder="acme-dashboard"
                      autoComplete="off"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Allowed origins</span>
                    <textarea
                      ref={developerOriginsRef}
                      placeholder="https://app.example.com&#10;https://staging.example.com"
                      rows={4}
                    />
                  </label>
                  <button type="submit" className="btn btn-primary btn-block" disabled={developerLoading}>
                    Register app <span className="arrow">→</span>
                  </button>
                </form>
              </section>

              <section className="developer-panel developer-panel-wide">
                <div className="developer-panel-head">
                  <h2>Registration requests</h2>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={refreshDeveloperRegistrations}
                    disabled={developerLoading}
                  >
                    Refresh
                  </button>
                </div>

                <div className="developer-table">
                  {developerRegistrations.length === 0 ? (
                    <p className="developer-empty">No registration requests loaded.</p>
                  ) : developerRegistrations.map((registration) => (
                    <div className="developer-registration-row" key={registration.app_registration_id}>
                      <span>
                        <strong>{registration.name}</strong>
                        <small>{registration.contact_email} · {registration.slug}</small>
                      </span>
                      <span className={`developer-registration-status is-${registration.status}`}>
                        {registration.status}
                      </span>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => handleApproveDeveloperRegistration(registration.app_registration_id)}
                        disabled={developerLoading || registration.status !== 'pending'}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => handleRejectDeveloperRegistration(registration.app_registration_id)}
                        disabled={developerLoading || registration.status !== 'pending'}
                      >
                        Reject
                      </button>
                    </div>
                  ))}
                </div>
              </section>

              <section className="developer-panel developer-panel-wide">
                <div className="developer-panel-head">
                  <h2>Applications</h2>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => refreshDeveloperApps()}
                    disabled={developerLoading}
                  >
                    Refresh
                  </button>
                </div>

                <div className="developer-list">
                  {developerApps.length === 0 ? (
                    <p className="developer-empty">No applications loaded.</p>
                  ) : developerApps.map((app) => (
                    <button
                      type="button"
                      className={`developer-app-row${app.application_id === selectedDeveloperAppId ? ' is-active' : ''}`}
                      key={app.application_id}
                      onClick={() => setSelectedDeveloperAppId(app.application_id)}
                    >
                      <span>
                        <strong>{app.name}</strong>
                        <small>{app.slug || app.application_id}</small>
                      </span>
                      <code>{app.application_id}</code>
                    </button>
                  ))}
                </div>
              </section>

              <section className="developer-panel developer-panel-wide">
                <div className="developer-panel-head">
                  <h2>Usage</h2>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => refreshDeveloperUsage()}
                    disabled={developerLoading || !selectedDeveloperAppId}
                  >
                    Refresh
                  </button>
                </div>

                {!developerUsage ? (
                  <p className="developer-empty">No usage loaded for the selected application.</p>
                ) : (
                  <div className="developer-usage-grid">
                    <div className="developer-usage-tile">
                      <span>Active keys</span>
                      <strong>{developerUsage.api_keys.active}</strong>
                      <small>{developerUsage.api_keys.revoked} revoked</small>
                    </div>
                    <div className="developer-usage-tile">
                      <span>End users</span>
                      <strong>{developerUsage.end_users.total}</strong>
                      <small>{developerUsage.end_users.enrolled} enrolled</small>
                    </div>
                    <div className="developer-usage-tile">
                      <span>Samples</span>
                      <strong>{developerUsage.typing_samples.total}</strong>
                      <small>{developerUsage.typing_samples.enrollment} enrollment</small>
                    </div>
                    <div className="developer-usage-tile">
                      <span>Scores</span>
                      <strong>{developerUsage.score_requests.total}</strong>
                      <small>{developerUsage.score_requests.accepted} accepted</small>
                    </div>
                    <div className="developer-usage-tile">
                      <span>Accept rate</span>
                      <strong>
                        {developerUsage.score_requests.acceptance_rate === null
                          ? '-'
                          : `${Math.round(developerUsage.score_requests.acceptance_rate * 100)}%`}
                      </strong>
                      <small>{developerUsage.score_requests.rejected} rejected</small>
                    </div>
                    <div className="developer-usage-tile">
                      <span>Avg score</span>
                      <strong>
                        {developerUsage.score_requests.avg_score_duration_ms == null
                          ? '-'
                          : `${Math.round(developerUsage.score_requests.avg_score_duration_ms)}ms`}
                      </strong>
                      <small>
                        p95 {developerUsage.score_requests.p95_score_duration_ms == null
                          ? '-'
                          : `${Math.round(developerUsage.score_requests.p95_score_duration_ms)}ms`}
                      </small>
                    </div>
                    <div className="developer-usage-tile">
                      <span>Top reason</span>
                      <strong>
                        {Object.entries(developerUsage.score_requests.reason_counts || {})
                          .sort((left, right) => right[1] - left[1])[0]?.[0] || '-'}
                      </strong>
                      <small>score decisions</small>
                    </div>
                  </div>
                )}
              </section>

              <section className="developer-panel developer-panel-wide">
                <div className="developer-panel-head">
                  <h2>API keys</h2>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => refreshDeveloperKeys()}
                    disabled={developerLoading || !selectedDeveloperAppId}
                  >
                    Refresh
                  </button>
                </div>

                {newDeveloperKey && (
                  <div className="developer-secret">
                    <span>New API key</span>
                    <code>{newDeveloperKey.key}</code>
                  </div>
                )}

                <form className="developer-key-form" onSubmit={handleCreateDeveloperKey}>
                  <label className="field">
                    <span className="field-label">Key name</span>
                    <input
                      ref={developerKeyNameRef}
                      type="text"
                      placeholder="production"
                      autoComplete="off"
                    />
                  </label>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={developerLoading || !selectedDeveloperAppId}
                  >
                    Create key
                  </button>
                </form>

                <div className="developer-table">
                  {developerKeys.length === 0 ? (
                    <p className="developer-empty">No keys for the selected application.</p>
                  ) : developerKeys.map((key) => (
                    <div className="developer-key-row" key={key.api_key_id}>
                      <span>
                        <strong>{key.name}</strong>
                        <small>{key.key_prefix}</small>
                      </span>
                      <span className={key.revoked_at ? 'developer-key-revoked' : 'developer-key-live'}>
                        {key.revoked_at ? 'revoked' : 'live'}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => handleRevokeDeveloperKey(key.api_key_id)}
                        disabled={developerLoading || Boolean(key.revoked_at)}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </section>

        <section className="route route-auth" data-route-view="register" hidden={view !== 'register'}>
          <div className="auth-card">
            <a className="auth-back" href="/" onClick={routeTo('landing')}>← back to home</a>
            <h1 className="auth-title">Create your account</h1>
            <p className="auth-sub">Join the dozens of teams (citation needed) already synergizing.</p>

            <form className="auth-form" id="register-form" autoComplete="off" noValidate onSubmit={handleRegister}>
              <label className="field">
                <span className="field-label">Work email</span>
                <input
                  type="email"
                  name="email"
                  id="register-email"
                  placeholder="ceo@your-startup.ai"
                  autoComplete="off"
                  required
                  ref={registerEmailRef}
                />
              </label>

              <label className="field">
                <span className="field-label">Username</span>
                <input
                  type="text"
                  name="username"
                  id="register-username"
                  placeholder="thought.leader.42"
                  autoComplete="username"
                  required
                  ref={registerUsernameRef}
                />
              </label>

              <label className="field">
                <span className="field-label">Password</span>
                <input
                  type="password"
                  name="password"
                  id="register-password"
                  placeholder="••••••••••••"
                  autoComplete="new-password"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  required
                  ref={registerPasswordRef}
                />
                <ul className="field-hint">
                  <li>At least 8 characters</li>
                  <li>One uppercase letter (A–Z)</li>
                  <li>One lowercase letter (a–z)</li>
                  <li>One number (0–9)</li>
                  <li>One special character (!@#$…)</li>
                  <li>Type naturally — Cadence uses your keystroke rhythm as a second factor</li>
                </ul>
              </label>

              <button type="submit" className="btn btn-primary btn-block">
                Create account <span className="arrow">→</span>
              </button>

              <Status value={statuses.register} />

              <p className="auth-switch">
                Already optimizing? <a href="/login" onClick={routeTo('login')}>Sign in</a>
              </p>
            </form>

            <div className="auth-aside">
              <p className="aside-eyebrow">By signing up you agree to:</p>
              <ul>
                <li>Receive 4-11 emails per day from Chad</li>
                <li>Be invited to a Discord you'll never visit</li>
                <li>Let Cadence (an external thing, not us) read your typing rhythm</li>
              </ul>
              <p className="powered-by powered-by-aside">
                <span className="powered-mark">◈</span> Powered by Cadence
              </p>
            </div>
          </div>
        </section>

        <section className="route route-auth" data-route-view="login" hidden={view !== 'login'}>
          <div className="auth-card">
            <a className="auth-back" href="/" onClick={routeTo('landing')}>← back to home</a>
            <h1 className="auth-title">Welcome back, synergist</h1>
            <p className="auth-sub">Sign in with your password. Cadence handles the rest.</p>

            <form className="auth-form" id="login-form" autoComplete="off" noValidate onSubmit={handleLogin}>
              <label className="field">
                <span className="field-label">Username</span>
                <input
                  type="text"
                  name="username"
                  id="login-username"
                  placeholder="thought.leader.42"
                  autoComplete="username"
                  required
                  ref={loginUsernameRef}
                />
              </label>

              <label className="field">
                <span className="field-label">Password</span>
                <input
                  type="password"
                  name="password"
                  id="login-password"
                  placeholder="••••••••••••"
                  autoComplete="new-password"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  required
                  ref={loginPasswordRef}
                />
                <span className="field-hint">
                  Type the way you always do. Cadence watches the rhythm, not the characters.
                </span>
              </label>

              <button type="submit" className="btn btn-primary btn-block">
                Sign in <span className="arrow">→</span>
              </button>

              <Status value={statuses.login} />

              <p className="auth-switch">
                No account yet? <a href="/register" onClick={routeTo('register')}>Start free trial</a>
              </p>
            </form>

            <div className="auth-aside">
              <p className="aside-eyebrow">Why two factors?</p>
              <ul>
                <li>Passwords leak. Your typing rhythm doesn't.</li>
                <li>If Cadence isn't sure it's you, it'll email a one-time code.</li>
                <li>Five clean logins and you're fully enrolled.</li>
              </ul>
              <p className="powered-by powered-by-aside">
                <span className="powered-mark">◈</span> Powered by Cadence
              </p>
            </div>
          </div>
        </section>

        <section className="route route-auth" data-route-view="twofa" hidden={view !== 'twofa'}>
          <div className="auth-card">
            <a className="auth-back" href="/login" onClick={routeTo('login')}>← back to sign in</a>
            <h1 className="auth-title">Verify it's you</h1>
            <p className="auth-sub">We sent a 6-digit code to your email. It's good for 5 minutes.</p>
            <p className="auth-sub">Don't worry - we don't care how you type this part.</p>

            <div className="demo-banner" id="demo-banner" hidden={!demoOtp}>
              <span className="demo-banner-label">Demo mode</span>
              <span className="demo-banner-text">
                No email needed - your code is <strong id="demo-otp">{demoOtp || '000000'}</strong>
              </span>
            </div>

            <form className="auth-form" id="twofa-form" autoComplete="off" noValidate onSubmit={handleTwofa}>
              <label className="field">
                <span className="field-label">One-time code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  name="code"
                  id="twofa-code"
                  placeholder="123456"
                  autoComplete="off"
                  required
                  ref={twofaCodeRef}
                />
              </label>

              <button type="submit" className="btn btn-primary btn-block">
                Verify <span className="arrow">→</span>
              </button>

              <Status value={statuses.twofa} />

              <p className="auth-switch">
                Didn't get it? <a href="#" id="twofa-resend" onClick={handleResend}>Resend code</a>
              </p>
            </form>
          </div>
        </section>

        <section className="route route-auth" data-route-view="dashboard" hidden={view !== 'dashboard'}>
          <div className="auth-card">
            <h1 className="auth-title">You're synergized. ✦</h1>
            <p className="auth-sub" id="dashboard-sub">{dashboardSub}</p>

            <Enrollment payload={enrollment} />


            <button type="button" className="btn btn-ghost btn-block" id="logout-btn" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </section>
      </main>
    </>
  );
}
