import assert from "node:assert/strict";
import test from "node:test";

import {
  getGoogleClientId,
  getGoogleClientSecret,
  getGoogleOAuthScopes,
  getGoogleRedirectUri,
} from "../../src/lib/server/auth-identities";

const originalEnv = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
  GOOGLE_OAUTH_SCOPES: process.env.GOOGLE_OAUTH_SCOPES,
};

test("getGoogleClientId trims whitespace", (context) => {
  context.after(() => {
    process.env.GOOGLE_CLIENT_ID = originalEnv.GOOGLE_CLIENT_ID;
  });

  process.env.GOOGLE_CLIENT_ID = "  client-id-123  ";
  assert.equal(getGoogleClientId(), "client-id-123");
});

test("getGoogleClientSecret trims whitespace", (context) => {
  context.after(() => {
    process.env.GOOGLE_CLIENT_SECRET = originalEnv.GOOGLE_CLIENT_SECRET;
  });

  process.env.GOOGLE_CLIENT_SECRET = "  secret-key  ";
  assert.equal(getGoogleClientSecret(), "secret-key");
});

test("getGoogleOAuthScopes uses override when env is set", (context) => {
  context.after(() => {
    process.env.GOOGLE_OAUTH_SCOPES = originalEnv.GOOGLE_OAUTH_SCOPES;
  });

  process.env.GOOGLE_OAUTH_SCOPES = "openid profile";
  assert.equal(getGoogleOAuthScopes(), "openid profile");
});

test("getGoogleOAuthScopes uses default when env is unset", (context) => {
  context.after(() => {
    process.env.GOOGLE_OAUTH_SCOPES = originalEnv.GOOGLE_OAUTH_SCOPES;
  });

  delete process.env.GOOGLE_OAUTH_SCOPES;
  assert.equal(getGoogleOAuthScopes(), "openid email profile");
});

test("getGoogleRedirectUri uses configured override", (context) => {
  context.after(() => {
    process.env.GOOGLE_REDIRECT_URI = originalEnv.GOOGLE_REDIRECT_URI;
  });

  process.env.GOOGLE_REDIRECT_URI = "https://example.com/auth/google/callback";
  const request = new Request("https://app.local/auth/google?next=%2F");
  assert.equal(
    getGoogleRedirectUri(request),
    "https://example.com/auth/google/callback",
  );
});

test("getGoogleRedirectUri defaults to request origin callback", (context) => {
  context.after(() => {
    process.env.GOOGLE_REDIRECT_URI = originalEnv.GOOGLE_REDIRECT_URI;
  });

  delete process.env.GOOGLE_REDIRECT_URI;
  const request = new Request("https://app.local/auth/google?next=%2F");
  assert.equal(
    getGoogleRedirectUri(request),
    "https://app.local/auth/google/callback",
  );
});
