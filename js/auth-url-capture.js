// Capture auth tokens from the URL before Supabase client initialization.
(function captureAuthParams() {
  const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  const queryParams = new URLSearchParams(window.location.search || '');
  window.__SB_AUTH_PARAMS__ = {
    access_token: hashParams.get('access_token'),
    refresh_token: hashParams.get('refresh_token'),
    type: hashParams.get('type'),
    code: queryParams.get('code'),
  };
})();
